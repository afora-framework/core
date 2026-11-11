import type { Authenticator, HttpOptions, SinkStage } from "../adapters";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	exceptionOf,
	outputOf,
	recordOf,
	useCaseOf,
} from "../index";
import type { ContractRunner } from "./provider-contract";

/** What the kit needs of a sink that serves HTTP. */
export interface HttpProviderContractSettings<Server> {
	/** The sink under test, made with these options and this authenticator. */
	sink(
		options: HttpOptions,
		hooks: { readonly authenticator?: Authenticator },
	): SinkStage<Server, HttpOptions>;
	/** Sends a request to the server the sink built, and gives its response. */
	fetch(server: Server, request: Request): Response | Promise<Response>;
	/** Releases the server (a listening socket), after each case. */
	close?(server: Server): void | Promise<void>;
}

const Note = recordOf(
	blueprintOf((ctx) => ({ title: ctx.string, secret: ctx.password })),
);
const Rejected = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ContractRejected",
	message: "rejected",
});
const Echo = blueprintOf((ctx) => ({
	id: ctx.optional.string,
	page: ctx.optional.integer,
	flag: ctx.optional.boolean,
	locale: ctx.optional.string,
	session: ctx.optional.string,
	title: ctx.optional.string,
	caller: ctx.optional.string,
	tenant: ctx.optional.string,
}));

function operations() {
	class Get extends useCaseOf({
		name: "ContractGet",
		blueprint: blueprintOf((ctx) => ({
			id: ctx.string,
			page: ctx.optional.integer,
			flag: ctx.optional.boolean,
		})),
		response: Echo,
		route: { method: "get", path: "/items/{id}" },
	}) {
		override async execute() {
			return { ...this.input };
		}
	}
	class Change extends useCaseOf({
		name: "ContractChange",
		blueprint: blueprintOf((ctx) => ({
			id: ctx.string,
			page: ctx.integer,
			locale: ctx.optional.string,
			session: ctx.optional.string,
			title: ctx.string,
		})),
		response: Echo,
		context: blueprintOf((ctx) => ({ tenant: ctx.optional.string })),
		errors: [Rejected],
		route: {
			method: "put",
			path: "/items/{id}",
			status: 201,
			query: ["page"],
			headers: { locale: "accept-language" },
			cookie: { session: "sid" },
		},
	}) {
		override async execute() {
			if (this.input.title === "reject") throw new Rejected({ source: "x" });
			if (this.input.title === "crash") throw new Error("internal detail");
			return { ...this.input, tenant: this.context.tenant };
		}
	}
	class Remove extends useCaseOf({
		name: "ContractRemove",
		blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
		response: blueprintOf(() => ({})),
		route: { method: "delete", path: "/items/{id}", status: 204 },
	}) {
		override async execute() {
			return {};
		}
	}
	class Reveal extends useCaseOf({
		name: "ContractReveal",
		blueprint: blueprintOf(() => ({})),
		response: blueprintOf(() => ({ note: Note })),
		route: { method: "get", path: "/note" },
	}) {
		override async execute() {
			return { note: new Note({ title: "t", secret: await hashed() }) };
		}
	}
	class Mine extends useCaseOf({
		name: "ContractMine",
		blueprint: blueprintOf(() => ({})),
		response: Echo,
		context: blueprintOf((ctx) => ({ caller: ctx.string })),
		route: { method: "get", path: "/mine" },
		access: { scopes: ["items:read"], context: { caller: "subject" } },
	}) {
		override async execute() {
			return { caller: this.context.caller };
		}
	}
	class Enter extends useCaseOf({
		name: "ContractEnter",
		blueprint: blueprintOf((ctx) => ({ title: ctx.string })),
		response: blueprintOf((ctx) => ({
			title: ctx.string,
			token: ctx.string,
			refreshToken: ctx.string,
		})),
		route: {
			method: "post",
			path: "/enter",
			setCookie: {
				token: { name: "sid", secure: false },
				refreshToken: { name: "rid", secure: false, path: "/refresh" },
			},
		},
	}) {
		override async execute() {
			return { title: this.input.title, token: "t 1", refreshToken: "" };
		}
	}
	return commandOf({
		name: "Contract",
		useCases: {
			get: Get,
			change: Change,
			remove: Remove,
			reveal: Reveal,
			mine: Mine,
			enter: Enter,
		},
	});
}

/** A value `ctx.password` accepts: the argon2 hash of a password. */
async function hashed(): Promise<string> {
	return "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$4VbQ3OqJ7xk8Y0mG0iZ1c2k1m2Qe0sQeJ7xk8Y0mG0i";
}

const authenticator: Authenticator = (request) => {
	const token = request.header("authorization");
	if (token === "Bearer reader")
		return { subject: "u1", scopes: ["items:read"] };
	if (token === "Bearer other") return { subject: "u2", scopes: [] };
	return null;
};

/**
 * The cases every sink that serves HTTP must pass, whatever its server: the
 * routes use cases declare, where each input key is read from, the context,
 * access, statuses, problems, cookies, the request id and the document. A
 * sink built on `compileRoutes` passes when it routes each method and path
 * to `handle` and sends the result as is.
 *
 * ```ts
 * import { describe, expect, it } from "bun:test";
 * import { httpProviderContract } from "@afora/core/testing";
 *
 * httpProviderContract(
 * 	"hono",
 * 	{ sink: (options, hooks) => hono(options, hooks), fetch: (app, request) => app.fetch(request) },
 * 	{ describe, it, expect },
 * );
 * ```
 */
export function httpProviderContract<Server>(
	name: string,
	settings: HttpProviderContractSettings<Server>,
	runner: ContractRunner,
): void {
	const { describe, it, expect } = runner;
	const origin = "http://contract.test";

	/** Runs `body` against a server of the sink with `options`. */
	const withServer = async (
		options: HttpOptions,
		body: (
			send: (
				method: string,
				path: string,
				init?: { headers?: Record<string, string>; body?: unknown },
			) => Promise<{
				status: number;
				type: string | null;
				headers: Headers;
				text: string;
				json: unknown;
			}>,
		) => Promise<void>,
		hooks: { authenticator?: Authenticator } = { authenticator },
	) => {
		const server = outputOf({
			name: "Contract",
			commands: [operations()],
			statuses: { ContractRejected: 409 },
			pipe: [settings.sink(options, hooks)],
		}).build();
		try {
			await body(async (method, path, init = {}) => {
				const hasBody = init.body !== undefined;
				const response = await settings.fetch(
					server,
					new Request(`${origin}${path}`, {
						method,
						headers: {
							...(hasBody ? { "content-type": "application/json" } : {}),
							...init.headers,
						},
						...(hasBody
							? {
									body:
										typeof init.body === "string"
											? init.body
											: JSON.stringify(init.body),
								}
							: {}),
					}),
				);
				const text = await response.text();
				let json: unknown;
				try {
					json = text === "" ? undefined : JSON.parse(text);
				} catch {
					json = undefined;
				}
				return {
					status: response.status,
					type: (response.headers.get("content-type") ?? "").split(
						";",
					)[0] as string,
					headers: response.headers,
					text,
					json,
				};
			});
		} finally {
			await settings.close?.(server);
		}
	};

	describe(`${name}: HTTP provider contract`, () => {
		it("serves the route a use case declares, path and query coerced", async () => {
			await withServer({ basePath: "/api" }, async (send) => {
				const found = await send("GET", "/api/items/a%20b?page=2&flag=true");
				expect(found.status).toBe(200);
				expect(found.type).toBe("application/json");
				expect(found.json).toEqual({ id: "a b", page: 2, flag: true });
			});
		});

		it("reads each key where the route places it, over the body", async () => {
			await withServer({}, async (send) => {
				const changed = await send("PUT", "/items/p?page=3", {
					headers: { "accept-language": "pt-BR", cookie: "x=1; sid=s%201" },
					body: { id: "from-body", page: 9, title: "T" },
				});
				expect(changed.status).toBe(201);
				expect(changed.json).toEqual({
					id: "p",
					page: 3,
					locale: "pt-BR",
					session: "s 1",
					title: "T",
				});
			});
		});

		it("fills the context from headers", async () => {
			await withServer(
				{ context: { headers: { tenant: "x-tenant" } } },
				async (send) => {
					const changed = await send("PUT", "/items/p?page=1", {
						headers: { "x-tenant": "acme" },
						body: { title: "T" },
					});
					expect((changed.json as { tenant?: string }).tenant).toBe("acme");
				},
			);
		});

		it("answers invalid input and invalid JSON with a 400 problem", async () => {
			await withServer({}, async (send) => {
				const invalid = await send("PUT", "/items/p?page=1", {
					body: { title: 1 },
				});
				expect(invalid.status).toBe(400);
				expect(invalid.type).toBe("application/problem+json");
				const problem = invalid.json as {
					title: string;
					issues: { path: unknown[] }[];
				};
				expect(problem.title).toBe("InvalidUseCaseInput");
				expect(problem.issues.map((issue) => issue.path)).toEqual([["title"]]);
				const notJson = await send("PUT", "/items/p?page=1", {
					body: "{nope",
				});
				expect(notJson.status).toBe(400);
				expect((notJson.json as { title: string }).title).toBe(
					"InvalidRequestBody",
				);
			});
		});

		it("gives errors the status of the output, and hides internal ones", async () => {
			await withServer({}, async (send) => {
				const rejected = await send("PUT", "/items/p?page=1", {
					body: { title: "reject" },
				});
				expect(rejected.status).toBe(409);
				expect(rejected.type).toBe("application/problem+json");
				const crashed = await send("PUT", "/items/p?page=1", {
					body: { title: "crash" },
				});
				expect(crashed.status).toBe(500);
				expect(crashed.text.includes("internal detail")).toBe(false);
			});
			await withServer({ debug: true }, async (send) => {
				const crashed = await send("PUT", "/items/p?page=1", {
					body: { title: "crash" },
				});
				expect(crashed.text.includes("internal detail")).toBe(true);
			});
		});

		it("answers a 204 without a body, and an unknown route with a 404 problem", async () => {
			await withServer({}, async (send) => {
				const removed = await send("DELETE", "/items/p");
				expect(removed.status).toBe(204);
				expect(removed.text).toBe("");
				const unknown = await send("GET", "/nowhere");
				expect(unknown.status).toBe(404);
				expect(unknown.type).toBe("application/problem+json");
				expect((unknown.json as { title: string }).title).toBe("NotFound");
			});
		});

		it("masks sensitive values", async () => {
			await withServer({}, async (send) => {
				const revealed = await send("GET", "/note");
				expect(revealed.json).toEqual({
					note: { title: "t", secret: "********" },
				});
			});
		});

		it("enforces the access of a use case", async () => {
			await withServer({}, async (send) => {
				const anonymous = await send("GET", "/mine");
				expect(anonymous.status).toBe(401);
				expect((anonymous.json as { title: string }).title).toBe(
					"Unauthenticated",
				);
				const other = await send("GET", "/mine", {
					headers: { authorization: "Bearer other" },
				});
				expect(other.status).toBe(403);
				const reader = await send("GET", "/mine", {
					headers: { authorization: "Bearer reader" },
				});
				expect(reader.status).toBe(200);
				expect(reader.json).toEqual({ caller: "u1" });
			});
			await withServer(
				{},
				async (send) => {
					const closed = await send("GET", "/mine", {
						headers: { authorization: "Bearer reader" },
					});
					expect(closed.status).toBe(401);
				},
				{},
			);
		});

		it("sends the cookies of a route, out of the body", async () => {
			await withServer({}, async (send) => {
				const entered = await send("POST", "/enter", { body: { title: "T" } });
				expect(entered.status).toBe(200);
				expect(entered.json).toEqual({ title: "T" });
				expect(entered.headers.getSetCookie()).toEqual([
					"sid=t%201; Path=/; HttpOnly; SameSite=Lax",
					"rid=; Path=/refresh; HttpOnly; SameSite=Lax; Max-Age=0",
				]);
			});
		});

		it("puts the request id on successes and problems", async () => {
			await withServer({ requestId: true }, async (send) => {
				const sent = await send("GET", "/items/a", {
					headers: { "x-request-id": "abc-1" },
				});
				expect(sent.headers.get("x-request-id")).toBe("abc-1");
				const problem = await send("GET", "/mine");
				expect((problem.headers.get("x-request-id") ?? "").length).toBe(36);
			});
		});

		it("serves the document of the same routes", async () => {
			await withServer(
				{
					basePath: "/api",
					docs: { path: "/openapi.json", info: { title: "C", version: "1" } },
				},
				async (send) => {
					const docs = await send("GET", "/openapi.json");
					expect(docs.status).toBe(200);
					expect(docs.type).toBe("application/json");
					expect(
						Object.keys((docs.json as { paths: object }).paths).sort(),
					).toEqual([
						"/api/enter",
						"/api/items/{id}",
						"/api/mine",
						"/api/note",
					]);
				},
			);
		});
	});
}
