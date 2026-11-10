import { describe, expect, test } from "bun:test";
import {
	ApplicationConflict,
	applicationOf,
	blueprintOf,
	commandOf,
	DuplicateOperation,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	outputOf,
	RepositoryUsedOutsideApplication,
	repositoryOf,
	select,
	sinkOf,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../index";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
const Total = blueprintOf((ctx) => ({ total: ctx.integer }));
const Context = blueprintOf((ctx) => ({ userId: ctx.id }));
const Boom = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Boom",
	message: "boom",
});

class Account extends entityOf(Name) {}
const Accounts = repositoryOf({
	entity: Account,
	actions: ["findById", "create", "count"],
});

class Register extends useCaseOf({
	name: "Register",
	blueprint: Name,
	response: Empty,
	dependencies: { accounts: Accounts },
}) {
	override async execute({ accounts = this.dependencies.accounts } = {}) {
		await accounts.create(new Account(this.input));
		return {};
	}
}
class RegisterAndFail extends useCaseOf({
	name: "RegisterAndFail",
	blueprint: Name,
	response: Empty,
	errors: [Boom],
	dependencies: { accounts: Accounts },
}) {
	override async execute({
		accounts = this.dependencies.accounts,
	}: {
		accounts?: typeof Accounts;
	} = {}): Promise<object> {
		await accounts.create(new Account(this.input));
		throw new Boom({ source: "RegisterAndFail" });
		// biome-ignore lint/correctness/noUnreachable: gives execute its return type
		return {};
	}
}
class Count extends useCaseOf({
	name: "Count",
	blueprint: Empty,
	response: Total,
	dependencies: { accounts: Accounts },
}) {
	override async execute({ accounts = this.dependencies.accounts } = {}) {
		return { total: await accounts.count() };
	}
}

const Users = commandOf({
	name: "Users",
	description: "Accounts",
	tags: ["accounts"],
	context: Context,
	transaction: true,
	events: () => {},
	onEventError: undefined,
	useCases: { register: Register, fail: RegisterAndFail, count: Count },
});
const base = {
	entities: { Account },
	repositories: { Accounts },
	useCases: { Register, RegisterAndFail, Count },
	exceptions: { Boom },
};
const userId = "0190a6a0-0000-7000-8000-000000000001";
const Reads = commandOf({ name: "Reads", useCases: { count: Count } });
const statuses = { Boom: 500 };
const Api = outputOf({
	name: "Api",
	commands: [Users, Reads],
	statuses,
	pipe: [select({ tags: ["accounts"] })],
});
const base2 = { ...base, commands: { Users, Reads } };

describe("registration", () => {
	test("registers an output under its outputName", () => {
		const app = applicationOf({ name: "a", ...base2, outputs: { Api } });
		expect(app.outputs.Api).toBe(Api);
		expect(app.output(Api)).toBe(Api);
	});

	test("the key must equal outputName", () => {
		expect(() =>
			applicationOf({ name: "a", ...base2, outputs: { Other: Api as never } }),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("a non-output is rejected", () => {
		expect(() =>
			applicationOf({ name: "a", ...base2, outputs: { Api: Users as never } }),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("an unnamed output (from pipe) is rejected", () => {
		const unnamed = Api.pipe(select({ tags: ["x"] }));
		expect(() =>
			applicationOf({
				name: "a",
				...base2,
				outputs: { Api: unnamed as never },
			}),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("every command must be registered", () => {
		try {
			applicationOf({
				name: "a",
				...base,
				commands: { Users },
				outputs: { Api },
			});
			throw new Error("did not throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnregisteredApplicationReference);
			expect((error as { details: unknown }).details).toMatchObject({
				output: "Api",
				command: "Reads",
			});
		}
	});

	test("app.output rejects an unregistered output", () => {
		const app = applicationOf({ name: "a", ...base2 });
		expect(() => app.output(Api as never)).toThrow(
			InvalidApplicationDeclaration,
		);
	});
});

describe("binding", () => {
	test("an output is rebuilt over the bound commands, memoized", async () => {
		const app = applicationOf({
			name: "a",
			...base2,
			outputs: { Api },
			provider: inMemoryProvider(),
		});
		const bound = app.outputs.Api;
		expect(bound).not.toBe(Api);
		expect(app.outputs.Api).toBe(bound);
		expect(app.output(Api)).toBe(bound);
		expect(bound.outputName).toBe("Api");
		expect(bound.statuses).toEqual(statuses);
		expect(bound.stages).toEqual(Api.stages);
		expect(bound.commands[0]).toBe(app.commands.Users);
		expect(bound.operations.map((op) => op.id)).toEqual(
			Api.operations.map((op) => op.id),
		);
		const register = bound.operations.find((op) => op.id === "Users.register");
		await register?.invoke({ name: "Ana" }, { context: { userId } });
		expect(await app.repositories.Accounts.count()).toBe(1);
		await expect(Accounts.count()).rejects.toThrow(
			RepositoryUsedOutsideApplication,
		);
	});

	test("a sink is kept and builds from the bound operations", () => {
		const sink = sinkOf<{ ids: string[] }>({
			name: "ids",
			build: (operations) => ({ ids: operations.map((op) => op.id) }),
		})();
		const Sunk = outputOf({ name: "Sunk", commands: [Reads], pipe: [sink] });
		const app = applicationOf({
			name: "a",
			...base2,
			outputs: { Sunk },
			provider: inMemoryProvider(),
		});
		expect(app.outputs.Sunk.build()).toEqual({ ids: ["Reads.count"] });
	});
});

describe("extends", () => {
	test("merges outputs and conflicts on different objects", () => {
		const first = applicationOf({ name: "first", ...base2, outputs: { Api } });
		const second = applicationOf({
			name: "second",
			...base2,
			outputs: { Api: outputOf({ name: "Api", commands: [Users] }) },
		});
		const merged = applicationOf({ name: "m", extends: [first] });
		expect(merged.outputs.Api).toBe(Api);
		expect(() =>
			applicationOf({ name: "m", extends: [first, second] }),
		).toThrow(ApplicationConflict);
		expect(
			applicationOf({ name: "m", extends: [first, first] }).outputs.Api,
		).toBe(Api);
	});
});

describe("describe", () => {
	test("lists commands, statuses and the pipe", () => {
		const hand = {
			kind: "transform" as const,
			name: "hand",
			apply: (op: never) => op,
		};
		const Mixed = outputOf({
			name: "Mixed",
			commands: [Reads],
			pipe: [select({ tags: ["accounts"] }), hand as never],
		});
		const app = applicationOf({
			name: "a",
			...base2,
			outputs: { Api, Mixed },
		});
		const { outputs } = app.describe();
		expect(outputs.Api).toEqual({
			from: "a",
			name: "Api",
			commands: ["Users", "Reads"],
			statuses,
			pipe: [
				{ kind: "transform", name: "select", options: { tags: ["accounts"] } },
			],
		});
		expect(outputs.Mixed?.pipe).toEqual([
			{ kind: "transform", name: "select", options: { tags: ["accounts"] } },
			{ kind: "opaque" },
		]);
		expect(JSON.parse(JSON.stringify(outputs))).toEqual(outputs);
	});
});

describe("application sources", () => {
	test("outputOf takes an application, mixed lists and dedupes", () => {
		const app = applicationOf({ name: "a", ...base2 });
		const all = outputOf({ name: "All", commands: app });
		expect(all.commands).toEqual([Users, Reads]);
		const mixed = outputOf({ name: "Mixed", commands: [Users, app] });
		expect(mixed.operations.map((op) => op.id)).toEqual([
			"Users.register",
			"Users.fail",
			"Users.count",
			"Reads.count",
		]);
		const Same = commandOf({ name: "Users", useCases: { count: Count } });
		expect(() => outputOf({ name: "Dup", commands: [Same, app] })).toThrow(
			DuplicateOperation,
		);
	});

	test("with a provider the application gives its bound commands", () => {
		const app = applicationOf({
			name: "a",
			...base2,
			provider: inMemoryProvider(),
		});
		const all = outputOf({ name: "All", commands: app });
		expect(all.commands[0]).toBe(app.commands.Users);
	});
});
