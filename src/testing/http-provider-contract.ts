import type { Authenticator, HttpOptions, SinkStage } from "../adapters";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	exceptionOf,
	outputOf,
	recordOf,
	useCaseOf,
	withStatus,
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
const Upstream = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ContractUpstream",
	message: "the upstream refused",
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
			if (this.input.title === "upstream") throw new Upstream({ source: "x" });
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
	class Unsubscribe extends useCaseOf({
		name: "ContractUnsubscribe",
		blueprint: blueprintOf((ctx) => ({
			id: ctx.string,
			page: ctx.optional.integer,
			title: ctx.string,
		})),
		response: Echo,
		route: {
			method: "delete",
			path: "/subscriptions/{id}",
			query: ["page"],
			body: true,
		},
	}) {
		override async execute() {
			return { ...this.input };
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
	class Upload extends useCaseOf({
		name: "ContractUpload",
		blueprint: blueprintOf((ctx) => ({
			folder: ctx.string,
			file: ctx.fileOf({ types: ["image/png", "image/*"], maxBytes: 64 }),
			count: ctx.optional.integer,
			flag: ctx.optional.boolean,
			tags: ctx.list.optional.string,
			extras: ctx.optionalOf(ctx.listOf(ctx.file)),
			meta: ctx.optionalOf(blueprintOf((ctx) => ({ alt: ctx.string }))),
		})),
		response: blueprintOf((ctx) => ({
			folder: ctx.string,
			name: ctx.string,
			type: ctx.string,
			size: ctx.integer,
			isFile: ctx.boolean,
			count: ctx.optional.integer,
			flag: ctx.optional.boolean,
			tags: ctx.list.optional.string,
			extras: ctx.list.optional.string,
			alt: ctx.optional.string,
		})),
		route: { method: "post", path: "/uploads/{folder}" },
	}) {
		override async execute() {
			const { file, extras, meta, ...rest } = this.input;
			return {
				...rest,
				name: file.name,
				type: file.type,
				size: file.size,
				isFile: file instanceof File,
				...(extras ? { extras: extras.map((extra) => extra.name) } : {}),
				...(meta ? { alt: meta.alt } : {}),
			};
		}
	}
	class Health extends useCaseOf({
		name: "ContractHealth",
		blueprint: blueprintOf((ctx) => ({ page: ctx.optional.integer })),
		response: Echo,
		route: { method: "get", path: "/health", statuses: [503] },
	}) {
		override async execute() {
			const { page } = this.input;
			return page === undefined
				? { title: "up" }
				: withStatus(page, { title: "down" });
		}
	}
	return commandOf({
		name: "Contract",
		useCases: {
			health: Health,
			get: Get,
			change: Change,
			remove: Remove,
			unsubscribe: Unsubscribe,
			reveal: Reveal,
			mine: Mine,
			enter: Enter,
			upload: Upload,
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
			statuses: { ContractRejected: 409, ContractUpstream: 502 },
			pipe: [settings.sink(options, hooks)],
		}).build();
		try {
			await body(async (method, path, init = {}) => {
				const hasBody = init.body !== undefined;
				// A form sets its own multipart content type, with the boundary.
				const form = init.body instanceof FormData;
				const response = await settings.fetch(
					server,
					new Request(`${origin}${path}`, {
						method,
						headers: {
							...(hasBody && !form
								? { "content-type": "application/json" }
								: {}),
							...init.headers,
						},
						...(hasBody
							? {
									body: form
										? (init.body as FormData)
										: typeof init.body === "string"
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

		it("reads the JSON body of a delete route with body: true", async () => {
			await withServer({}, async (send) => {
				const removed = await send("DELETE", "/subscriptions/s?page=2", {
					body: { id: "from-body", page: 9, title: "T" },
				});
				expect(removed.status).toBe(200);
				expect(removed.json).toEqual({ id: "s", page: 2, title: "T" });
				// No body is `{}`, so the required key is missing.
				const empty = await send("DELETE", "/subscriptions/s");
				expect(empty.status).toBe(400);
				expect(
					(empty.json as { issues: { path: unknown[] }[] }).issues.map(
						(issue) => issue.path,
					),
				).toEqual([["title"]]);
			});
		});

		it("never reads a header, cookie or route query key from the body", async () => {
			await withServer({}, async (send) => {
				const changed = await send("PUT", "/items/p?page=1", {
					body: { title: "T", locale: "evil", session: "evil" },
				});
				expect(changed.status).toBe(201);
				expect(changed.json).toEqual({ id: "p", page: 1, title: "T" });
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

		it("SEC-48: reads a body only as JSON, a +json type included", async () => {
			await withServer({}, async (send) => {
				const body = JSON.stringify({ title: "T" });
				for (const type of [
					"text/plain",
					"text/plain;charset=UTF-8",
					"application/x-www-form-urlencoded",
				]) {
					const refused = await send("PUT", "/items/p?page=1", {
						headers: { "content-type": type },
						body,
					});
					expect(refused.status).toBe(415);
					expect((refused.json as { title: string }).title).toBe(
						"UnsupportedMediaType",
					);
				}
				const read = await send("PUT", "/items/p?page=1", {
					headers: { "content-type": "application/merge-patch+json" },
					body,
				});
				expect(read.status).toBe(201);
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
				expect((crashed.json as { detail: string }).detail).toBe(
					"Internal error.",
				);
				// Declared by the output: its detail is kept at a 5xx.
				const upstream = await send("PUT", "/items/p?page=1", {
					body: { title: "upstream" },
				});
				expect(upstream.status).toBe(502);
				expect(upstream.type).toBe("application/problem+json");
				expect((upstream.json as { detail: string }).detail).toBe(
					"the upstream refused",
				);
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

		it("sends the status a use case chose, if its route declares it", async () => {
			await withServer({}, async (send) => {
				const up = await send("GET", "/health");
				expect(up.status).toBe(200);
				expect(up.json).toEqual({ title: "up" });
				const down = await send("GET", "/health?page=503");
				expect(down.status).toBe(503);
				expect(down.type).toBe("application/json");
				expect(down.json).toEqual({ title: "down" });
				const undeclared = await send("GET", "/health?page=418");
				expect(undeclared.status).toBe(500);
				expect(undeclared.type).toBe("application/problem+json");
				const { title, detail } = undeclared.json as {
					title: string;
					detail: string;
				};
				expect([title, detail]).toEqual([
					"UndeclaredStatus",
					"Internal error.",
				]);
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

		it("reads a multipart body for an input with a file", async () => {
			await withServer({}, async (send) => {
				// An image of `size` bytes: the signature of its type, then zeros.
				const signatures: Record<string, number[]> = {
					"image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
					"image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
					"image/webp": [
						0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
					],
				};
				const image = (type: string, size: number, name = "a.png") => {
					const bytes = new Uint8Array(size);
					bytes.set((signatures[type] ?? []).slice(0, size));
					return new File([bytes], name, { type });
				};
				const form = (entries: [string, string | File][]) => {
					const data = new FormData();
					for (const [key, value] of entries) data.append(key, value);
					return data;
				};
				const sent = await send("POST", "/uploads/docs?count=9", {
					body: form([
						["folder", "from-body"],
						["file", image("image/png", 10)],
						["count", "3"],
						["flag", "true"],
						["tags", "a"],
						["tags", "b"],
						["extras", image("image/gif", 8, "x.gif")],
						["extras", image("image/gif", 8, "y.gif")],
						["meta", '{"alt":"A"}'],
					]),
				});
				expect(sent.status).toBe(200);
				expect(sent.json).toEqual({
					folder: "docs",
					name: "a.png",
					type: "image/png",
					size: 10,
					isFile: true,
					count: 3,
					flag: true,
					tags: ["a", "b"],
					extras: ["x.gif", "y.gif"],
					alt: "A",
				});

				const one = await send("POST", "/uploads/docs", {
					body: form([
						["file", image("image/webp", 64, "b.webp")],
						["tags", "only"],
					]),
				});
				expect(one.status).toBe(200);
				expect((one.json as { tags: string[] }).tags).toEqual(["only"]);

				const wrongType = await send("POST", "/uploads/docs", {
					body: form([["file", image("text/plain", 4, "a.txt")]]),
				});
				expect(wrongType.status).toBe(400);
				expect(wrongType.type).toBe("application/problem+json");
				const typeIssues = (wrongType.json as { issues: { path: unknown }[] })
					.issues;
				expect(typeIssues.map((issue) => issue.path)).toEqual([["file"]]);

				const tooLarge = await send("POST", "/uploads/docs", {
					body: form([["file", image("image/png", 65)]]),
				});
				expect(tooLarge.status).toBe(400);
				expect(
					(tooLarge.json as { issues: { path: unknown }[] }).issues.map(
						(issue) => issue.path,
					),
				).toEqual([["file"]]);

				const notAFile = await send("POST", "/uploads/docs", {
					body: form([
						["file", "text"],
						["count", "x"],
					]),
				});
				expect(notAFile.status).toBe(400);
				expect(
					(notAFile.json as { issues: { path: unknown }[] }).issues
						.map((issue) => issue.path)
						.sort(),
				).toEqual([["count"], ["file"]]);

				const disguised = await send("POST", "/uploads/docs", {
					body: form([
						["file", new File(["<svg/>"], "a.png", { type: "image/png" })],
					]),
				});
				expect(disguised.status).toBe(400);
				expect((disguised.json as { title: string }).title).toBe(
					"InvalidFileContent",
				);

				// A body that is not multipart after all, or has no boundary.
				for (const type of [
					"multipart/form-data; boundary=nope",
					"multipart/form-data",
				]) {
					const malformed = await send("POST", "/uploads/docs", {
						headers: { "content-type": type },
						body: "not a multipart body",
					});
					expect(malformed.status).toBe(400);
					expect((malformed.json as { title: string }).title).toBe(
						"InvalidRequestBody",
					);
				}

				// A route without a file reads JSON only: a multipart body is a 415.
				const notJson = await send("POST", "/enter", {
					body: form([["title", "T"]]),
				});
				expect(notJson.status).toBe(415);
				expect((notJson.json as { title: string }).title).toBe(
					"UnsupportedMediaType",
				);

				// JSON still works for the other keys; the file is then missing.
				const json = await send("POST", "/uploads/docs", {
					body: { count: 1 },
				});
				expect(json.status).toBe(400);
				expect(
					(json.json as { issues: { path: unknown }[] }).issues.map(
						(issue) => issue.path,
					),
				).toEqual([["file"]]);
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
						"/api/health",
						"/api/items/{id}",
						"/api/mine",
						"/api/note",
						"/api/subscriptions/{id}",
						"/api/uploads/{folder}",
					]);
					const upload = (
						docs.json as {
							paths: Record<
								string,
								{ post: { requestBody: { content: object } } }
							>;
						}
					).paths["/api/uploads/{folder}"];
					expect(Object.keys(upload?.post.requestBody.content ?? {})).toEqual([
						"multipart/form-data",
					]);
					const health = (
						docs.json as {
							paths: Record<string, { get: { responses: object } }>;
						}
					).paths["/api/health"];
					expect(Object.keys(health?.get.responses ?? {})).toEqual([
						"200",
						"400",
						"500",
						"503",
					]);
				},
			);
		});
	});
}
