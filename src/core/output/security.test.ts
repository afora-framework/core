import { describe, expect, test } from "bun:test";
import {
	compileRoutes,
	type HttpRequest,
	problemOf,
	statusOf,
} from "../../adapters";
import {
	blueprintOf,
	commandOf,
	Exception,
	Forbidden,
	InvalidUseCaseStep,
	outputOf,
	type Principal,
	Route,
	useCaseOf,
} from "../../index";

/** What the use case acted on: the value after the pipeline of its property. */
const Seen = blueprintOf((ctx) => ({ actedOn: ctx.string }));
let runs = 0;

// Email trims and lowercases; Slug slugifies; an integer is compared as text.
class ReadInbox extends useCaseOf({
	name: "ReadInbox",
	blueprint: blueprintOf((ctx) => ({ email: ctx.email })),
	response: Seen,
	access: { owner: { input: "email", claim: "email" } },
}) {
	override async execute() {
		runs++;
		return { actedOn: this.input.email };
	}
}
class ReadBySlug extends useCaseOf({
	name: "ReadBySlug",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug })),
	response: Seen,
	access: { owner: { input: "slug" } },
}) {
	override async execute() {
		runs++;
		return { actedOn: this.input.slug };
	}
}
class ReadByNumber extends useCaseOf({
	name: "ReadByNumber",
	blueprint: blueprintOf((ctx) => ({ account: ctx.integer })),
	response: Seen,
	access: { owner: { input: "account" } },
}) {
	override async execute() {
		runs++;
		return { actedOn: String(this.input.account) };
	}
}
@Route("GET", "/inbox/{email}")
class ReadInboxOverHttp extends useCaseOf({
	name: "ReadInboxOverHttp",
	blueprint: blueprintOf((ctx) => ({ email: ctx.email })),
	response: Seen,
	access: { owner: { input: "email", claim: "email" } },
}) {
	override async execute() {
		runs++;
		return { actedOn: this.input.email };
	}
}

const Mail = commandOf({
	name: "Mail",
	useCases: {
		read: ReadInbox,
		slug: ReadBySlug,
		number: ReadByNumber,
		http: ReadInboxOverHttp,
	},
});
const Api = outputOf({ name: "Api", commands: [Mail] });
const op = (name: string) => {
	const found = Api.operations.find(({ id }) => id === `Mail.${name}`);
	if (!found) throw new Error(name);
	return found;
};
const failure = async (promise: Promise<unknown>): Promise<Exception> => {
	try {
		await promise;
	} catch (error) {
		return error as Exception;
	}
	throw new Error("Expected the call to fail.");
};
const withEmail = (email: string): Principal => ({
	subject: "someone",
	scopes: [],
	claims: { email },
});

describe("SEC-02: the owner is compared on the value the use case acts on", () => {
	test("SEC-02: a claim that only normalizes to the victim's email is refused", async () => {
		runs = 0;
		const attacker = withEmail(" Victim@Example.com");
		const error = await failure(
			op("read").invoke(
				{ email: " Victim@Example.com" },
				{ principal: attacker },
			),
		);
		expect(error.is(Forbidden)).toBe(true);
		expect(error.details).toEqual({ reason: "owner" });
		const canonical = await failure(
			op("read").invoke(
				{ email: "victim@example.com" },
				{ principal: attacker },
			),
		);
		expect(canonical.is(Forbidden)).toBe(true);
		expect(runs).toBe(0);
	});

	test("SEC-02: the owner reaches their data whatever the spelling of the input", async () => {
		const victim = withEmail("victim@example.com");
		expect(
			await op("read").invoke(
				{ email: " Victim@Example.com " },
				{ principal: victim },
			),
		).toEqual({ actedOn: "victim@example.com" });
		expect(
			await op("read").invoke(
				{ email: "victim@example.com" },
				{ principal: victim },
			),
		).toEqual({ actedOn: "victim@example.com" });
	});

	test("SEC-02: a subject that only slugifies to the owner is refused", async () => {
		runs = 0;
		const error = await failure(
			op("slug").invoke(
				{ slug: "Victim!" },
				{ principal: { subject: "Victim!", scopes: [] } },
			),
		);
		expect(error.is(Forbidden)).toBe(true);
		expect(runs).toBe(0);
		expect(
			await op("slug").invoke(
				{ slug: "Victim!" },
				{ principal: { subject: "victim", scopes: [] } },
			),
		).toEqual({ actedOn: "victim" });
	});

	test("SEC-02: an owner value the property rejects is Forbidden, never authorized", async () => {
		runs = 0;
		const error = await failure(
			op("read").invoke(
				{ email: "not an email" },
				{ principal: withEmail("not an email") },
			),
		);
		expect(error.is(Forbidden)).toBe(true);
		expect(error.details).toEqual({ reason: "owner" });
		expect(runs).toBe(0);
	});

	test("SEC-02: a claim that is not a scalar never matches", async () => {
		const Tenant = useCaseOf({
			name: "Tenant",
			blueprint: blueprintOf((ctx) => ({ tenant: ctx.slug })),
			response: Seen,
			access: { owner: { input: "tenant", claim: "tenant" } },
		});
		class ReadTenant extends Tenant {
			override async execute() {
				return { actedOn: this.input.tenant };
			}
		}
		const [operation] = outputOf({
			name: "T",
			commands: [commandOf({ name: "T", useCases: { read: ReadTenant } })],
		}).operations;
		const error = await failure(
			(operation as (typeof Api.operations)[number]).invoke(
				{ tenant: "acme" },
				{
					principal: { subject: "x", scopes: [], claims: { tenant: ["acme"] } },
				},
			),
		);
		expect(error.is(Forbidden)).toBe(true);
	});

	test("SEC-02: a number input still matches its subject as text", async () => {
		expect(
			await op("number").invoke(
				{ account: 42 },
				{ principal: { subject: "42", scopes: [] } },
			),
		).toEqual({ actedOn: "42" });
		const error = await failure(
			op("number").invoke(
				{ account: 42 },
				{ principal: { subject: "042", scopes: [] } },
			),
		);
		expect(error.is(Forbidden)).toBe(true);
	});

	test("SEC-02: over HTTP, a path value that normalizes to the victim is refused", async () => {
		runs = 0;
		const table = compileRoutes(
			Api.operations,
			{},
			{ output: { name: "Api", statuses: {} } },
			{
				source: "test",
				authenticator: () => withEmail("Victim@Example.com"),
			},
		);
		const route = table.routes.find(
			({ operation }) => operation.id === "Mail.http",
		);
		if (!route) throw new Error("route");
		const request = (email: string): HttpRequest => ({
			param: (name) => (name === "email" ? email : undefined),
			query: () => ({}),
			header: () => undefined,
			text: () => "",
			variable: () => undefined,
		});
		const attack = await route.handle(request("Victim@Example.com"));
		expect(attack.status).toBe(403);
		const control = await route.handle(request("victim@example.com"));
		expect(control.status).toBe(403);
		expect(runs).toBe(0);
	});
});

