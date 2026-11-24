import { describe, expect, test } from "bun:test";
import {
	compileRoutes,
	type HttpRequest,
	outputValueOf,
	problemOf,
	statusOf,
} from "../../adapters";
import { sliceOf } from "../../experimental";
import {
	blueprintOf,
	commandOf,
	Exception,
	entityOf,
	Forbidden,
	InvalidUseCaseStep,
	listOf,
	MASK,
	openapi,
	operationOf,
	optionalOf,
	outputOf,
	Password,
	type Principal,
	Route,
	transformOf,
	useCaseOf,
	variantOf,
	withStatus,
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

class BadResponse extends useCaseOf({
	name: "BadResponse",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({
		internalBalanceCents: ctx.integer,
		ownerEmail: ctx.email,
	})),
	route: { method: "get", path: "/stats" },
}) {
	override async execute() {
		return { internalBalanceCents: 12.5, ownerEmail: "not-an-email" } as never;
	}
}
class Echo extends useCaseOf({
	name: "Echo",
	blueprint: blueprintOf((ctx) => ({ email: ctx.email })),
	response: Seen,
	route: { method: "post", path: "/echo" },
}) {
	override async execute() {
		return { actedOn: this.input.email };
	}
}
const Stats = commandOf({
	name: "Stats",
	useCases: { bad: BadResponse, echo: Echo },
});

describe("SEC-12: internal exceptions are not answered as the caller's input", () => {
	const responseError = async (): Promise<Exception> => {
		const [operation] = outputOf({ name: "S", commands: [Stats] }).operations;
		return failure(
			(operation as (typeof Api.operations)[number]).invoke({}, undefined),
		);
	};

	test("SEC-12: InvalidUseCaseResponse is a 500, masked, with no issues", async () => {
		const error = await responseError();
		expect(error.name).toBe("InvalidUseCaseResponse");
		const status = statusOf(error);
		expect(status).toBe(500);
		const problem = problemOf(error, { status });
		expect(problem.detail).toBe("Internal error.");
		expect(problem).not.toHaveProperty("issues");
	});

	test("SEC-12: listing it does not expose its issues or message", async () => {
		const error = await responseError();
		const statuses = { InvalidUseCaseResponse: 400 };
		expect(statusOf(error, undefined, statuses)).toBe(400);
		const problem = problemOf(error, { status: 400, statuses });
		expect(problem.detail).toBe("Internal error.");
		expect(problem).not.toHaveProperty("issues");
	});

	test("SEC-12: debug still shows the detail", async () => {
		const error = await responseError();
		const problem = problemOf(error, { status: 500, debug: true });
		expect(problem.detail).toContain("Invalid UseCase response");
		expect(problem.trace).toBeDefined();
	});

	test("SEC-12: an InvalidUseCaseStep raised while running is a masked 500", () => {
		const error = new InvalidUseCaseStep({
			source: "Steps",
			details: {
				index: 0,
				reason: "args rejected",
				code: "invalid_target",
				issues: [
					{
						path: ["secretField"],
						code: "invalid_value",
						message: "must be integer",
						source: "integer",
					},
				],
			},
		} as never);
		const status = statusOf(error);
		expect(status).toBe(500);
		const problem = problemOf(error, { status });
		expect(problem.detail).toBe("Internal error.");
		expect(problem).not.toHaveProperty("issues");
	});

	test("SEC-12: the caller's invalid input stays a 400 with its issues", () => {
		const error = new Exception({
			layer: "use-case" as never,
			name: "InvalidUseCaseInput",
			source: "Echo",
			message: 'Invalid UseCase input: "email" must match format "email".',
			details: {
				issues: [
					{
						path: ["email"],
						code: "invalid_value",
						message: 'must match format "email"',
						source: "email",
					},
				],
			},
		});
		const status = statusOf(error);
		expect(status).toBe(400);
		expect(problemOf(error, { status }).issues).toEqual([
			{
				path: ["email"],
				code: "invalid_value",
				message: 'must match format "email"',
			},
		]);
	});

	test("SEC-12: over HTTP, a bad response is a masked 500 and bad input a 400", async () => {
		const table = compileRoutes(
			outputOf({ name: "S", commands: [Stats] }).operations,
			{},
			{ output: { name: "S", statuses: {} } },
			{ source: "test" },
		);
		const route = (id: string) => {
			const found = table.routes.find(({ operation }) => operation.id === id);
			if (!found) throw new Error(id);
			return found;
		};
		const request = (body: unknown): HttpRequest => ({
			param: () => undefined,
			query: () => ({}),
			header: (name) =>
				name.toLowerCase() === "content-type" ? "application/json" : undefined,
			text: () => JSON.stringify(body),
			variable: () => undefined,
		});
		const bad = await route("Stats.bad").handle(request({}));
		expect(bad.status).toBe(500);
		const problem = JSON.parse(bad.body as string);
		expect(problem.detail).toBe("Internal error.");
		expect(problem).not.toHaveProperty("issues");
		expect(bad.body as string).not.toContain("internalBalanceCents");
		const input = await route("Stats.echo").handle(request({ email: "x" }));
		expect(input.status).toBe(400);
		expect(JSON.parse(input.body as string).issues).toHaveLength(1);
	});
});

describe("SEC-19: a response declared by a blueprint is masked in every output", () => {
	const HASH = Password.demo().value;
	const Empty = blueprintOf(() => ({}));
	const HolderFields = blueprintOf((ctx) => ({
		email: ctx.email,
		password: ctx.password,
		token: ctx.string,
	}));
	class Holder extends entityOf(HolderFields, { sensitive: ["token"] }) {}
	const holder = new Holder({
		email: "a@b.co",
		password: HASH,
		token: "t0k3n",
	});
	const Credential = blueprintOf((ctx) => ({
		email: ctx.email,
		password: ctx.password,
	}));
	const credential = { email: "a@b.co", password: HASH };
	const masked = { email: "a@b.co", password: MASK };

	class Own extends useCaseOf({
		name: "Own",
		blueprint: Empty,
		response: Holder.blueprint,
	}) {
		override async execute() {
			return holder as never;
		}
	}
	class Many extends useCaseOf({
		name: "Many",
		blueprint: Empty,
		response: listOf(Holder.blueprint),
	}) {
		override async execute() {
			return [holder] as never;
		}
	}
	class Fields extends useCaseOf({
		name: "Fields",
		blueprint: Empty,
		response: HolderFields,
	}) {
		override async execute() {
			return holder;
		}
	}
	class Plain extends useCaseOf({
		name: "Plain",
		blueprint: Empty,
		response: Credential,
	}) {
		override async execute() {
			return credential;
		}
	}
	class Nested extends useCaseOf({
		name: "Nested",
		blueprint: Empty,
		response: blueprintOf(() => ({
			inner: Credential,
			items: listOf(Credential),
			kind: variantOf("kind", {
				credential: Credential,
				other: blueprintOf((ctx) => ({ name: ctx.string })),
			}),
		})),
	}) {
		override async execute() {
			return {
				inner: credential,
				items: [credential, credential],
				kind: { kind: "credential" as const, ...credential },
			};
		}
	}
	class Chosen extends useCaseOf({
		name: "Chosen",
		blueprint: Empty,
		response: Credential,
		route: { method: "post", path: "/chosen", statuses: [503] },
	}) {
		override async execute() {
			return withStatus(503, credential);
		}
	}
	class AsRecord extends useCaseOf({
		name: "AsRecord",
		blueprint: Empty,
		response: blueprintOf(() => ({ holder: Holder })),
	}) {
		override async execute() {
			return { holder };
		}
	}
	const Leaks = commandOf({
		name: "Leaks",
		useCases: {
			own: Own,
			many: Many,
			fields: Fields,
			plain: Plain,
			nested: Nested,
			chosen: Chosen,
			record: AsRecord,
		},
	});
	const operations = outputOf({ name: "L", commands: [Leaks] }).operations;
	const operation = (name: string) => {
		const found = operations.find(({ id }) => id === `Leaks.${name}`);
		if (!found) throw new Error(name);
		return found;
	};
	const holderJson = JSON.parse(JSON.stringify(holder));
	const expected: Record<string, unknown> = {
		own: holderJson,
		many: [holderJson],
		fields: { ...masked, token: MASK },
		plain: masked,
		nested: {
			inner: masked,
			items: [masked, masked],
			kind: { kind: "credential", ...masked },
		},
		chosen: masked,
		record: { holder: holderJson },
	};

	test("SEC-19: outputValueOf masks sensitive values of a blueprint response", async () => {
		for (const [name, value] of Object.entries(expected)) {
			const sent = outputValueOf(await operation(name).invoke({}));
			expect(JSON.stringify(sent)).not.toContain(HASH);
			expect(JSON.stringify(sent)).not.toContain("t0k3n");
			expect(sent).toEqual(value);
		}
	});

	test("SEC-19: over HTTP, a blueprint response is sent masked", async () => {
		const table = compileRoutes(
			operations,
			{},
			{ output: { name: "L", statuses: {} } },
			{ source: "test" },
		);
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({}),
			header: (name) =>
				name.toLowerCase() === "content-type" ? "application/json" : undefined,
			text: () => "{}",
			variable: () => undefined,
		};
		for (const [name, value] of Object.entries(expected)) {
			const route = table.routes.find(
				(found) => found.operation.id === `Leaks.${name}`,
			);
			if (!route) throw new Error(name);
			const sent = await route.handle(request);
			expect(sent.status).toBe(name === "chosen" ? 503 : 200);
			expect(sent.body as string).not.toContain(HASH);
			expect(sent.body as string).not.toContain("t0k3n");
			expect(JSON.parse(sent.body as string)).toEqual(value);
		}
	});

	test("SEC-19: a key a route sends as a cookie keeps its value", async () => {
		class Session extends entityOf(
			blueprintOf((ctx) => ({ token: ctx.string, name: ctx.string })),
			{ sensitive: ["token"] },
		) {}
		class Open extends useCaseOf({
			name: "Open",
			blueprint: Empty,
			response: Session.blueprint,
			route: {
				method: "post",
				path: "/open",
				setCookie: { token: { name: "sid" } },
			},
		}) {
			override async execute() {
				return new Session({ token: "s1d", name: "n" }) as never;
			}
		}
		class Peek extends useCaseOf({
			name: "Peek",
			blueprint: Empty,
			response: Session.blueprint,
		}) {
			override async execute() {
				return new Session({ token: "s1d", name: "n" }) as never;
			}
		}
		const table = compileRoutes(
			outputOf({
				name: "C",
				commands: [
					commandOf({ name: "C", useCases: { open: Open, peek: Peek } }),
				],
			}).operations,
			{},
			{ output: { name: "C", statuses: {} } },
			{ source: "test" },
		);
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({}),
			header: (name) =>
				name.toLowerCase() === "content-type" ? "application/json" : undefined,
			text: () => "{}",
			variable: () => undefined,
		};
		const route = (id: string) => {
			const found = table.routes.find(({ operation }) => operation.id === id);
			if (!found) throw new Error(id);
			return found;
		};
		const open = await route("C.open").handle(request);
		expect(open.cookies.some((cookie) => cookie.startsWith("sid=s1d"))).toBe(
			true,
		);
		expect(JSON.parse(open.body as string)).not.toHaveProperty("token");
		const peek = await route("C.peek").handle(request);
		expect(JSON.parse(peek.body as string).token).toBe(MASK);
	});

	test("SEC-19: a direct call still reads the real values", async () => {
		const plain = await new Plain({}).execute();
		expect(plain.password).toBe(HASH);
		const own = await new Own({}).execute();
		expect(own).toMatchObject({ token: "t0k3n" });
		const nested = await new Nested({}).execute();
		expect(nested.items[1]?.password).toBe(HASH);
	});
});

describe("SEC-34: the OpenAPI document marks write-only every key a response masks", () => {
	const Empty = blueprintOf(() => ({}));
	const AccountFields = blueprintOf((ctx) => ({
		name: ctx.string,
		token: ctx.string,
	}));
	class Account extends entityOf(AccountFields, { sensitive: ["token"] }) {}
	const Other = blueprintOf((ctx) => ({ label: ctx.string }));
	const Nested = blueprintOf(() => ({
		inner: AccountFields,
		items: listOf(AccountFields),
		kind: variantOf("kind", { account: AccountFields, other: Other }),
	}));
	const declare = <
		Response extends Parameters<typeof useCaseOf>[0]["response"],
	>(
		name: string,
		response: Response,
	) =>
		class extends useCaseOf({ name, blueprint: Empty, response } as never) {
			override async execute() {
				return undefined as never;
			}
		};
	const document = outputOf({
		name: "D",
		commands: [
			commandOf({
				name: "D",
				useCases: {
					own: declare("own", Account.blueprint),
					fields: declare("fields", AccountFields),
					many: declare("many", listOf(Account.blueprint)),
					nested: declare("nested", Nested),
				},
			}),
		],
		pipe: [openapi({ info: { title: "D", version: "1" } })],
	}).build();
	// biome-ignore lint/suspicious/noExplicitAny: the document is read as JSON.
	const responseOf = (name: string): any => {
		const operations = Object.values(
			document.paths as Record<string, Record<string, unknown>>,
		).flatMap((slot) => Object.values(slot));
		const operation = operations.find(
			(found) =>
				(found as { operationId?: string }).operationId === `D_${name}`,
		) as {
			responses: Record<
				string,
				{ content: Record<string, { schema: unknown }> }
			>;
		};
		return operation.responses["200"]?.content["application/json"]?.schema;
	};

	test("SEC-34: a record's sensitive keys are write-only in a blueprint response", () => {
		expect(responseOf("own").properties.token.writeOnly).toBe(true);
		expect(responseOf("fields").properties.token.writeOnly).toBe(true);
		expect(responseOf("own").properties.name.writeOnly).toBeUndefined();
		expect(responseOf("many").items.properties.token.writeOnly).toBe(true);
	});

	test("SEC-34: at any depth of blueprints, lists and variants", () => {
		const nested = responseOf("nested").properties;
		expect(nested.inner.properties.token.writeOnly).toBe(true);
		expect(nested.items.items.properties.token.writeOnly).toBe(true);
		const [account, other] = nested.kind.oneOf;
		expect(account.properties.token.writeOnly).toBe(true);
		expect(other.properties.label.writeOnly).toBeUndefined();
	});
});

/** What every output sends of `operations`: by `outputValueOf` and over HTTP. */
async function sentOf(
	operations: readonly import("./types/output.interface").OperationDescriptor[],
): Promise<Record<string, { readonly value: unknown; readonly body: string }>> {
	const table = compileRoutes(
		operations,
		{},
		{ output: { name: "S", statuses: {} } },
		{ source: "test" },
	);
	const request: HttpRequest = {
		param: () => undefined,
		query: () => ({}),
		header: (name) =>
			name.toLowerCase() === "content-type" ? "application/json" : undefined,
		text: () => "{}",
		variable: () => undefined,
	};
	const sent: Record<string, { value: unknown; body: string }> = {};
	for (const route of table.routes) {
		const { operation } = route;
		const response = await route.handle(request);
		expect(response.status).toBe(200);
		sent[operation.name] = {
			value: outputValueOf(await operation.invoke({})),
			body: response.body as string,
		};
	}
	return sent;
}

/** The response schemas of the OpenAPI document of `useCases`, by operation name. */
function responseSchemasOf(
	useCases: Record<string, ReturnType<typeof useCaseOf>>,
): Record<string, unknown> {
	const document = outputOf({
		name: "D",
		commands: [commandOf({ name: "D", useCases } as never)],
		pipe: [openapi({ info: { title: "D", version: "1" } })],
	}).build() as {
		paths: Record<string, Record<string, unknown>>;
		components?: { schemas?: Record<string, unknown> };
	};
	const schemas: Record<string, unknown> = {};
	for (const slot of Object.values(document.paths)) {
		for (const operation of Object.values(slot) as {
			operationId: string;
			responses: Record<
				string,
				{ content: Record<string, { schema: unknown }> }
			>;
		}[]) {
			schemas[operation.operationId.replace(/^D_/, "")] =
				operation.responses["200"]?.content["application/json"]?.schema;
		}
	}
	return schemas;
}

/** Every schema under `schema` that describes `key`, at any depth. */
// biome-ignore lint/suspicious/noExplicitAny: the document is read as JSON.
function schemasOfKey(schema: any, key: string): any[] {
	if (typeof schema !== "object" || schema === null) return [];
	return Object.entries(schema).flatMap(([name, item]) => [
		...(name === "properties" && (item as Record<string, unknown>)[key]
			? [(item as Record<string, unknown>)[key]]
			: []),
		...schemasOfKey(item, key),
	]);
}

describe("SEC-43: a record's sensitive keys stay masked through optionalOf", () => {
	const Empty = blueprintOf(() => ({}));
	const Fields = blueprintOf((ctx) => ({
		email: ctx.email,
		token: ctx.string,
	}));
	class Account extends entityOf(Fields, { sensitive: ["token"] }) {}
	const account = new Account({ email: "a@b.co", token: "t0k3n" });
	const raw = { email: "a@b.co", token: "t0k3n" };
	const Other = blueprintOf((ctx) => ({ label: ctx.string }));
	const declare = (name: string, response: unknown, value: () => unknown) =>
		class extends useCaseOf({ name, blueprint: Empty, response } as never) {
			override async execute() {
				return value() as never;
			}
		};
	const useCases = {
		entity: declare(
			"entity",
			blueprintOf(() => ({ me: optionalOf(Account.blueprint) })),
			() => ({ me: account }),
		),
		fields: declare(
			"fields",
			blueprintOf(() => ({ me: optionalOf(Fields) })),
			() => ({ me: raw }),
		),
		many: declare(
			"many",
			listOf(blueprintOf(() => ({ me: optionalOf(Account.blueprint) }))),
			() => [{ me: account }],
		),
		variant: declare(
			"variant",
			blueprintOf(() => ({
				kind: variantOf("kind", { account: optionalOf(Fields), other: Other }),
			})),
			() => ({ kind: { kind: "account", ...raw } }),
		),
	};
	const operations = outputOf({
		name: "S",
		commands: [commandOf({ name: "S", useCases })],
	}).operations;

	test("SEC-43: outputValueOf and HTTP mask them", async () => {
		const sent = await sentOf(operations);
		expect(Object.keys(sent).sort()).toEqual(Object.keys(useCases).sort());
		for (const [name, { value, body }] of Object.entries(sent)) {
			expect(JSON.stringify(value), name).not.toContain("t0k3n");
			expect(body, name).not.toContain("t0k3n");
			expect(body, name).toContain(MASK);
		}
	});

	test("SEC-43: the OpenAPI document marks them write-only", () => {
		const schemas = responseSchemasOf(useCases);
		for (const name of Object.keys(useCases)) {
			const tokens = schemasOfKey(schemas[name], "token");
			expect(tokens.length, name).toBeGreaterThan(0);
			for (const token of tokens) expect(token.writeOnly, name).toBe(true);
		}
	});
});

describe("SEC-44: a record's sensitive keys stay masked in a joined or sliced blueprint", () => {
	const Empty = blueprintOf(() => ({}));
	const Fields = blueprintOf((ctx) => ({
		email: ctx.email,
		token: ctx.string,
	}));
	class Account extends entityOf(Fields, { sensitive: ["token"] }) {}
	const raw = { email: "a@b.co", token: "t0k3n" };
	const Extra = blueprintOf((ctx) => ({ extra: ctx.string }));
	const declare = (name: string, response: unknown, value: () => unknown) =>
		class extends useCaseOf({ name, blueprint: Empty, response } as never) {
			override async execute() {
				return value() as never;
			}
		};
	const useCases = {
		joined: declare("joined", Fields.join(Extra), () => ({
			...raw,
			extra: "x",
		})),
		joinedAfter: declare("joinedAfter", Extra.join(Fields), () => ({
			...raw,
			extra: "x",
		})),
		sliced: declare(
			"sliced",
			sliceOf(Account.blueprint, { email: true, token: true }),
			() => raw,
		),
		nested: declare(
			"nested",
			sliceOf(
				blueprintOf(() => ({ me: Fields, other: Extra })),
				{ me: { token: true } },
			),
			() => ({ me: { token: "t0k3n" } }),
		),
	};
	const operations = outputOf({
		name: "S",
		commands: [commandOf({ name: "S", useCases })],
	}).operations;

	test("SEC-44: outputValueOf and HTTP mask them", async () => {
		const sent = await sentOf(operations);
		expect(Object.keys(sent).sort()).toEqual(Object.keys(useCases).sort());
		for (const [name, { value, body }] of Object.entries(sent)) {
			expect(JSON.stringify(value), name).not.toContain("t0k3n");
			expect(body, name).not.toContain("t0k3n");
			expect(body, name).toContain(MASK);
		}
	});

	test("SEC-44: the OpenAPI document marks them write-only", () => {
		const schemas = responseSchemasOf(useCases);
		for (const name of Object.keys(useCases)) {
			const tokens = schemasOfKey(schemas[name], "token");
			expect(tokens.length, name).toBeGreaterThan(0);
			for (const token of tokens) expect(token.writeOnly, name).toBe(true);
		}
	});

	test("SEC-44: only the keys kept are marked, and the source keeps its own", () => {
		const Sliced = sliceOf(Account.blueprint, { email: true });
		const schemas = responseSchemasOf({
			sliced: declare("sliced", Sliced, () => ({ email: "a@b.co" })),
			fields: declare("fields", Fields, () => raw),
		});
		expect(schemasOfKey(schemas.sliced, "token")).toEqual([]);
		expect(schemasOfKey(schemas.sliced, "email")[0].writeOnly).toBeUndefined();
		expect(schemasOfKey(schemas.fields, "token")[0].writeOnly).toBe(true);
	});
});

describe("SEC-45: a transform that copies the response leaves it masked", () => {
	const HASH = Password.demo().value;
	const Empty = blueprintOf(() => ({}));
	const Credential = blueprintOf((ctx) => ({
		email: ctx.email,
		password: ctx.password,
	}));
	class Me extends useCaseOf({
		name: "Me",
		blueprint: Empty,
		response: Credential,
	}) {
		override async execute() {
			return { email: "a@b.co", password: HASH };
		}
	}
	class All extends useCaseOf({
		name: "All",
		blueprint: Empty,
		response: listOf(Credential),
	}) {
		override async execute() {
			return [{ email: "a@b.co", password: HASH }];
		}
	}
	const copying = (copy: (value: unknown) => unknown) =>
		transformOf({
			name: "copying",
			apply: (operation) =>
				operationOf(operation, {
					invoke: async (input, call) =>
						copy(await operation.invoke(input, call)),
				}),
		})();

	for (const [name, copy] of [
		["structuredClone", (value: unknown) => structuredClone(value)],
		[
			"spread",
			(value: unknown) =>
				Array.isArray(value)
					? value.map((item) => ({ ...item }))
					: { ...(value as object) },
		],
	] as const) {
		test(`SEC-45: a copy by ${name} is masked by the declared response`, async () => {
			const output = outputOf({
				name: "S",
				commands: [commandOf({ name: "S", useCases: { me: Me, all: All } })],
				pipe: [copying(copy)],
			});
			const sent = await sentOf(output.operations);
			expect(Object.keys(sent).sort()).toEqual(["all", "me"]);
			for (const { value, body } of Object.values(sent)) {
				expect(JSON.stringify(value)).not.toContain(HASH);
				expect(body).not.toContain(HASH);
				expect(body).toContain(MASK);
			}
		});
	}
});
