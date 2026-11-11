import { describe, expect, test } from "bun:test";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { problemOf, statusOf } from "../../adapters";
import {
	Access,
	applicationOf,
	blueprintOf,
	commandOf,
	Forbidden,
	InvalidOutputStage,
	InvalidUseCaseDeclaration,
	openapi,
	outputOf,
	type Principal,
	Unauthenticated,
	useCaseOf,
} from "../../index";

const Seen = blueprintOf((ctx) => ({
	userId: ctx.optional.string,
	tenant: ctx.optional.string,
}));
const Input = blueprintOf((ctx) => ({ owner: ctx.string, note: ctx.string }));
const Context = blueprintOf((ctx) => ({
	userId: ctx.string,
	tenant: ctx.optional.string,
}));

class Open extends useCaseOf({
	name: "Open",
	blueprint: Input,
	response: Seen,
}) {
	override async execute() {
		return {};
	}
}
class Anyone extends useCaseOf({
	name: "Anyone",
	blueprint: Input,
	response: Seen,
	access: { public: true },
}) {
	override async execute() {
		return {};
	}
}
class SignedIn extends useCaseOf({
	name: "SignedIn",
	blueprint: Input,
	response: Seen,
	access: {},
}) {
	override async execute() {
		return {};
	}
}
@Access({
	scopes: ["notes:write", "notes:read"],
	owner: { input: "owner" },
	context: { userId: "subject", tenant: "claims.tenant" },
})
class Write extends useCaseOf({
	name: "Write",
	blueprint: Input,
	response: Seen,
	context: Context,
}) {
	override async execute() {
		return { userId: this.context.userId, tenant: this.context.tenant };
	}
}
class ByTenant extends useCaseOf({
	name: "ByTenant",
	blueprint: Input,
	response: Seen,
	access: { owner: { input: "owner", claim: "tenant" } },
}) {
	override async execute() {
		return {};
	}
}

const Notes = commandOf({
	name: "Notes",
	useCases: {
		open: Open,
		anyone: Anyone,
		signedIn: SignedIn,
		write: Write,
		byTenant: ByTenant,
	},
});
const Api = outputOf({ name: "Api", commands: [Notes] });
const operation = (name: string) => {
	const found = Api.operations.find(({ id }) => id === `Notes.${name}`);
	if (!found) throw new Error(name);
	return found;
};
const input = { owner: "u1", note: "hi" };
const ana: Principal = {
	subject: "u1",
	scopes: ["notes:read", "notes:write"],
	claims: { tenant: "acme" },
};
const failure = async (run: Promise<unknown>) => {
	try {
		await run;
	} catch (error) {
		return error as InstanceType<typeof Forbidden>;
	}
	throw new Error("did not reject");
};

describe("access declaration", () => {
	test("the setting and the decorator give the same frozen data", () => {
		expect(Open.access).toBeUndefined();
		expect(Anyone.access).toEqual({ public: true });
		expect(SignedIn.access).toEqual({});
		expect(Write.access).toEqual({
			scopes: ["notes:write", "notes:read"],
			owner: { input: "owner" },
			context: { userId: "subject", tenant: "claims.tenant" },
		});
		expect(Object.isFrozen(Write.access)).toBe(true);
		expect(operation("write").access).toBe(Write.access);
		expect(operation("open")).not.toHaveProperty("access");
	});

	test("rejects what does not fit", () => {
		const declare = (access: unknown) => () =>
			useCaseOf({
				name: "Bad",
				blueprint: Input,
				response: Seen,
				access: access as never,
			});
		for (const access of [
			"admin",
			{ role: "admin" },
			{ public: true, scopes: ["a"] },
			{ scopes: ["a", "a"] },
			{ scopes: [""] },
			{ owner: { input: "nope" } },
			{ owner: { input: "owner", claim: "" } },
			{ context: { userId: "name" } },
		]) {
			expect(declare(access)).toThrow(InvalidUseCaseDeclaration);
		}
		expect(() => Access({})(class {})).toThrow(InvalidUseCaseDeclaration);
		expect(() => Access({ scopes: ["x"] })(SignedIn)).toThrow(
			InvalidUseCaseDeclaration,
		);
		// The same access again is one declaration.
		Access({})(SignedIn);
		expect(SignedIn.access).toEqual({});
	});

	test("a context key the operation lacks is rejected when it becomes one", () => {
		class Fills extends useCaseOf({
			name: "Fills",
			blueprint: Input,
			response: Seen,
			access: { context: { userId: "subject" } },
		}) {
			override async execute() {
				return {};
			}
		}
		expect(() =>
			outputOf({
				name: "Bad",
				commands: [commandOf({ name: "Bad", useCases: { fills: Fills } })],
			}),
		).toThrow(InvalidOutputStage);
	});

	test("describe() carries it", () => {
		const app = applicationOf({
			name: "notes",
			useCases: { Open, Anyone, SignedIn, Write, ByTenant },
			commands: { Notes },
		});
		expect(app.describe().useCases.Write?.access).toEqual(Write.access);
		expect(app.describe().useCases.Open).not.toHaveProperty("access");
	});
});

describe("access enforcement", () => {
	test("an operation without access, or a public one, runs for anyone", async () => {
		expect(await operation("open").invoke(input)).toEqual({});
		expect(await operation("anyone").invoke(input)).toEqual({});
		expect(
			await operation("anyone").invoke(input, { principal: null }),
		).toEqual({});
		expect(await operation("open").invoke(input, { principal: ana })).toEqual(
			{},
		);
	});

	test("no caller is a 401, before the input is looked at", async () => {
		for (const options of [undefined, {}, { principal: null }]) {
			const error = await failure(
				operation("signedIn").invoke({ nonsense: true }, options),
			);
			expect(error.is(Unauthenticated)).toBe(true);
			expect(statusOf(error, operation("signedIn"))).toBe(401);
		}
		expect(
			await operation("signedIn").invoke(input, {
				principal: { subject: "x", scopes: [] },
			}),
		).toEqual({});
	});

	test("a missing scope is a 403 naming it", async () => {
		const error = await failure(
			operation("write").invoke(input, {
				principal: { ...ana, scopes: ["notes:read"] },
			}),
		);
		expect(error.is(Forbidden)).toBe(true);
		expect(error.details).toEqual({ reason: "scope", scopes: ["notes:write"] });
		expect(statusOf(error, operation("write"))).toBe(403);
		expect(problemOf(error, { status: 403 })).toMatchObject({
			type: "urn:afora:exception:Forbidden",
			status: 403,
			layer: "output",
		});
	});

	test("the owner must be the caller", async () => {
		const other = await failure(
			operation("write").invoke(
				{ owner: "u2", note: "hi" },
				{ principal: ana },
			),
		);
		expect(other.details).toEqual({ reason: "owner" });
		const missing = await failure(
			operation("write").invoke({ note: "hi" }, { principal: ana }),
		);
		expect(missing.is(Forbidden)).toBe(true);
		expect(
			await operation("byTenant").invoke(
				{ owner: "acme", note: "hi" },
				{ principal: ana },
			),
		).toEqual({});
		const noClaim = await failure(
			operation("byTenant").invoke(
				{ owner: "acme", note: "hi" },
				{ principal: { subject: "u1", scopes: [] } },
			),
		);
		expect(noClaim.details).toEqual({ reason: "owner" });
	});

	test("the context is filled from the caller, over what the request sent", async () => {
		expect(
			await operation("write").invoke(input, {
				principal: ana,
				context: { userId: "forged", tenant: "forged" },
			}),
		).toEqual({ userId: "u1", tenant: "acme" });
		expect(
			await operation("write").invoke(input, {
				principal: { subject: "u1", scopes: ana.scopes },
				context: { tenant: "forged" },
			}),
		).toEqual({ userId: "u1" });
	});

	test("a call in process is trusted", async () => {
		expect(
			await Notes.run("write", input, { context: { userId: "system" } }),
		).toEqual({ userId: "system" });
	});
});

describe("openapi security from access", () => {
	const info = { title: "Notes", version: "1.0.0" };
	const build = (security?: object) =>
		outputOf({
			name: "Docs",
			commands: [Notes],
			pipe: [openapi({ info, ...(security ? { security } : {}) } as never)],
		}).build();
	const at = (document: ReturnType<typeof build>, name: string) =>
		document.paths[`/notes/${name}`]?.post as {
			security?: unknown;
			responses: Record<string, unknown>;
		};
	const bearer = { schemes: { bearer: { type: "http", scheme: "bearer" } } };

	test("documents the requirement and the 401 and 403 of each operation", async () => {
		const document = build(bearer);
		const result = await new Validator().validate(
			document as unknown as SpecData,
		);
		expect(result.errors ?? []).toEqual([]);
		expect(at(document, "write").security).toEqual([
			{ bearer: ["notes:write", "notes:read"] },
		]);
		expect(Object.keys(at(document, "write").responses)).toEqual([
			"200",
			"400",
			"401",
			"403",
			"500",
		]);
		expect(at(document, "signed-in").security).toEqual([{ bearer: [] }]);
		expect(Object.keys(at(document, "signed-in").responses)).toEqual([
			"200",
			"400",
			"401",
			"500",
		]);
		expect(at(document, "open")).not.toHaveProperty("security");
		expect(at(document, "anyone")).not.toHaveProperty("security");
		expect(Object.keys(at(document, "open").responses)).toEqual([
			"200",
			"400",
			"500",
		]);
	});

	test("a public operation opts out of the default requirement", () => {
		const document = build({ ...bearer, default: { scheme: "bearer" } });
		expect(at(document, "anyone").security).toEqual([]);
		expect(at(document, "open")).not.toHaveProperty("security");
	});

	test("an explicit requirement documents the operation; false contradicts an access", () => {
		const document = build({
			...bearer,
			operations: { "Notes.write": { scheme: "bearer", scopes: ["all"] } },
		});
		expect(at(document, "write").security).toEqual([{ bearer: ["all"] }]);
		expect(() =>
			build({ ...bearer, operations: { "Notes.write": false } }),
		).toThrow(InvalidOutputStage);
	});

	test("without a scheme, only the responses are documented", () => {
		const document = build();
		expect(at(document, "write")).not.toHaveProperty("security");
		expect(Object.keys(at(document, "write").responses)).toContain("403");
	});
});
