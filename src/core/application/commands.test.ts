import { describe, expect, test } from "bun:test";
import {
	ApplicationConflict,
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	environmentOf,
	exceptionOf,
	InvalidApplicationDeclaration,
	InvalidCommandDeclaration,
	inMemoryProvider,
	repositoryOf,
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

describe("registration", () => {
	test("registers a command under its commandName", () => {
		const app = applicationOf({ name: "a", ...base, commands: { Users } });
		expect(app.commands.Users).toBe(Users);
		expect(app.command(Users)).toBe(Users);
	});

	test("the key must equal commandName", () => {
		expect(() =>
			applicationOf({
				name: "a",
				...base,
				commands: { Other: Users as never },
			}),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("a non-command is rejected", () => {
		expect(() =>
			applicationOf({
				name: "a",
				...base,
				commands: { Users: Register as never },
			}),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("every use case must be registered", () => {
		try {
			applicationOf({
				name: "a",
				...base,
				useCases: { Register, Count },
				commands: { Users },
			});
			throw new Error("did not throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnregisteredApplicationReference);
			expect((error as { details: unknown }).details).toMatchObject({
				command: "Users",
				useCase: "RegisterAndFail",
			});
		}
	});

	test("app.command rejects an unregistered command", () => {
		const app = applicationOf({ name: "a", ...base });
		expect(() => app.command(Users as never)).toThrow(
			InvalidApplicationDeclaration,
		);
	});
});

describe("binding", () => {
	test("a command is rebuilt over the bound use cases, memoized", async () => {
		const provider = inMemoryProvider();
		const app = applicationOf({
			name: "a",
			...base,
			commands: { Users },
			provider,
		});
		const bound = app.commands.Users;
		expect(bound).not.toBe(Users);
		expect(app.commands.Users).toBe(bound);
		expect(app.command(Users)).toBe(bound);
		expect(bound.useCases.register).toBe(app.useCases.Register);
		expect(bound.transaction).toBe(true);
		expect(bound.commandName).toBe("Users");
		expect(bound.description).toBe("Accounts");
		expect(bound.tags).toEqual(["accounts"]);
		expect(bound.context).toBe(Users.context);
		expect(bound.events).toBe(Users.events);
		await bound.run("register", { name: "Ana" }, { context: { userId } });
		expect(await app.repositories.Accounts.count()).toBe(1);
	});

	test("a transaction rolls back through app.commands", async () => {
		const app = applicationOf({
			name: "a",
			...base,
			commands: { Users },
			provider: inMemoryProvider(),
		});
		await expect(
			app.commands.Users.run("fail", { name: "Ana" }, { context: { userId } }),
		).rejects.toBeDefined();
		expect(await app.repositories.Accounts.count()).toBe(0);
	});

	test("the transaction check runs against the app provider", () => {
		expect(() =>
			applicationOf({
				name: "a",
				...base,
				commands: { Users },
				provider: { ...inMemoryProvider(), transaction: undefined },
			}),
		).toThrow(InvalidCommandDeclaration);
	});

	test("onEventError is kept when rebuilding", () => {
		const onEventError = () => {};
		const Events = commandOf({
			name: "Events",
			onEventError,
			useCases: { count: Count },
		});
		const app = applicationOf({
			name: "a",
			...base,
			commands: { Events },
			provider: inMemoryProvider(),
		});
		expect(app.commands.Events.onEventError).toBe(onEventError);
	});
});

describe("extends", () => {
	test("merges commands and conflicts on different objects", () => {
		const first = applicationOf({
			name: "first",
			...base,
			commands: { Users },
		});
		const Other = commandOf({ name: "Users", useCases: { count: Count } });
		const second = applicationOf({
			name: "second",
			...base,
			commands: { Users: Other },
		});
		const merged = applicationOf({
			name: "m",
			extends: [first, applicationOf({ name: "x", extends: [first] })],
		});
		expect(merged.commands.Users).toBe(Users);
		expect(() =>
			applicationOf({ name: "c", extends: [first, second] }),
		).toThrow(ApplicationConflict);
	});

	test("extending inherits the provider binding", () => {
		const first = applicationOf({
			name: "first",
			...base,
			commands: { Users },
			provider: inMemoryProvider(),
		});
		const child = applicationOf({ name: "child", extends: [first] });
		expect(child.commands.Users).not.toBe(Users);
	});
});

describe("describe", () => {
	test("describes commands", () => {
		const Plain = commandOf({
			name: "Plain",
			events: "manual",
			useCases: { count: Count },
		});
		const app = applicationOf({
			name: "a",
			...base,
			commands: { Users, Plain },
		});
		const { commands } = app.describe();
		expect(commands.Users).toEqual({
			from: "a",
			name: "Users",
			description: "Accounts",
			tags: ["accounts"],
			context: expect.any(Object),
			operations: {
				register: { ref: "Register" },
				fail: { ref: "RegisterAndFail" },
				count: { ref: "Count" },
			},
			transaction: true,
			events: { kind: "opaque" },
		});
		expect(commands.Plain).toEqual({
			from: "a",
			name: "Plain",
			tags: [],
			operations: { count: { ref: "Count" } },
			transaction: false,
			events: "manual",
		});
		expect("onEventError" in (commands.Plain ?? {})).toBe(false);
		JSON.stringify(commands);
	});

	test("onEventError appears as opaque when set", () => {
		const C = commandOf({
			name: "C",
			onEventError: () => {},
			useCases: { count: Count },
		});
		const app = applicationOf({ name: "a", ...base, commands: { C } });
		expect(app.describe().commands.C?.onEventError).toEqual({ kind: "opaque" });
		expect(app.describe().commands.C?.events).toBe("after-commit");
	});
});

describe("transactions over repositories an application binds", () => {
	class Note extends entityOf(Name) {}
	class Tag extends entityOf(Name) {}
	const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });
	const Tags = repositoryOf({ entity: Tag, actions: ["create", "count"] });
	class Tagged extends useCaseOf({
		name: "Tagged",
		blueprint: Name,
		response: Empty,
		errors: [Boom],
		dependencies: { notes: Notes, tags: Tags },
	}) {
		override async execute({
			notes = this.dependencies.notes,
			tags = this.dependencies.tags,
		}: {
			notes?: typeof Notes;
			tags?: typeof Tags;
		} = {}): Promise<object> {
			await notes.create(new Note(this.input));
			await tags.create(new Tag(this.input));
			if (this.input.name === "fail") throw new Boom({ source: "Tagged" });
			return {};
		}
	}
	const Notebook = commandOf({
		name: "Notebook",
		useCases: { tag: Tagged },
		transaction: true,
	});

	test("declares, and fails on its first call when the providers differ", async () => {
		await expect(Notebook.run("tag", { name: "a" })).rejects.toBeInstanceOf(
			InvalidCommandDeclaration,
		);
	});

	test("an application provider makes them one, and rolls both back", async () => {
		const App = applicationOf({
			name: "notebook",
			entities: { Note, Tag },
			repositories: { Notes, Tags },
			useCases: { Tagged },
			exceptions: { Boom },
			commands: { Notebook },
			provider: inMemoryProvider(),
		});
		await App.commands.Notebook.run("tag", { name: "ok" });
		await expect(
			App.commands.Notebook.run("tag", { name: "fail" }),
		).rejects.toMatchObject({ name: "Boom" });
		expect(await App.repositories.Notes.count()).toBe(1);
		expect(await App.repositories.Tags.count()).toBe(1);
	});

	test("an application provider without transactions fails when it binds", () => {
		const { transaction: _, ...plain } = inMemoryProvider();
		expect(() =>
			applicationOf({
				name: "notebook",
				entities: { Note, Tag },
				repositories: { Notes, Tags },
				useCases: { Tagged },
				exceptions: { Boom },
				commands: { Notebook },
				provider: plain as never,
			}),
		).toThrow(InvalidCommandDeclaration);
	});
});

describe("environments", () => {
	const Queue = environmentOf(
		blueprintOf((ctx) => ({ QUEUE_URL: ctx.url })),
		{ source: () => ({ QUEUE_URL: "https://queue.example.com" }) },
	);
	const Queued = commandOf({
		name: "Queued",
		useCases: { count: Count },
		environmentDependencies: Queue,
	});

	test("the environments of a command must be registered", () => {
		try {
			applicationOf({ name: "a", ...base, commands: { Queued } });
			throw new Error("did not throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnregisteredApplicationReference);
			expect((error as { details: { command: string } }).details.command).toBe(
				"Queued",
			);
		}
	});

	test("are kept when rebuilt over a provider, and described by name", () => {
		const app = applicationOf({
			name: "a",
			...base,
			environments: { Queue },
			commands: { Queued },
			provider: inMemoryProvider(),
		});
		const bound = app.commands.Queued;
		expect(bound).not.toBe(Queued);
		expect(bound.environments).toEqual([Queue]);
		expect(bound.env.QUEUE_URL).toBe("https://queue.example.com");
		expect(app.describe().commands.Queued?.environments).toEqual(["Queue"]);
	});
});
