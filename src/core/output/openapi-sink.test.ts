import { describe, expect, test } from "bun:test";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { PROBLEM_MEDIA_TYPE } from "../../adapters";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidOutputStage,
	listOf,
	openapi,
	outputOf,
	StdStages,
	useCaseOf,
} from "../../index";

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		password: ctx.password,
	})),
	{ unique: ["email"] },
) {}
class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, author: User })),
) {}

const Taken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "EmailTaken",
	message: "taken",
});
const NoRights = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "NoRights",
	message: "no rights",
});

class Register extends useCaseOf({
	name: "Register",
	description: "Creates an account.",
	tags: ["public"],
	blueprint: blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		password: ctx.password,
	})),
	response: blueprintOf(() => ({ user: User })),
	errors: [Taken],
}) {
	override async execute() {
		return {} as never;
	}
}
class Login extends useCaseOf({
	name: "Login",
	blueprint: blueprintOf((ctx) => ({
		email: ctx.email,
		password: ctx.password,
	})),
	response: blueprintOf((ctx) => ({ token: ctx.string })),
}) {
	override async execute() {
		return {} as never;
	}
}
class ChangePassword extends useCaseOf({
	name: "ChangePassword",
	deprecated: true,
	blueprint: blueprintOf((ctx) => ({ password: ctx.password })),
	response: blueprintOf(() => ({})),
}) {
	override async execute() {
		return {} as never;
	}
}
class Publish extends useCaseOf({
	name: "Publish",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text, author: User })),
	response: blueprintOf(() => ({ post: Post })),
	errors: [NoRights],
}) {
	override async execute() {
		return {} as never;
	}
}
class List extends useCaseOf({
	name: "List",
	blueprint: blueprintOf((ctx) => ({ page: ctx.optional.integer })),
	response: blueprintOf(() => ({ items: listOf(Post) })),
}) {
	override async execute() {
		return {} as never;
	}
}

const Users = commandOf({
	name: "Users",
	useCases: {
		register: Register,
		login: Login,
		changePassword: ChangePassword,
	},
});
const Posts = commandOf({
	name: "Posts",
	useCases: { publish: Publish, list: List },
});

const info = { title: "Blog", version: "1.0.0" };

async function validated(document: unknown) {
	const result = await new Validator().validate(document as SpecData);
	expect(result.errors ?? []).toEqual([]);
	expect(result.valid).toBe(true);
}

describe("openapi sink", () => {
	const Api = outputOf({
		name: "Blog",
		commands: [Users, Posts],
		statuses: { EmailTaken: 409 },
		pipe: [
			openapi({
				info,
				basePath: "/api",
				servers: [{ url: "https://blog.test" }],
				route: { "Posts.list": { method: "get" } },
			}),
		],
	});
	const document = Api.build();

	test("is a valid OpenAPI 3.1 document", async () => {
		await validated(document);
		expect(document.openapi).toBe("3.1.0");
	});

	test("matches the snapshot", () => {
		expect(document).toMatchSnapshot();
	});

	test("routes by convention and per operation", () => {
		expect(Object.keys(document.paths)).toEqual([
			"/api/users/register",
			"/api/users/login",
			"/api/users/change-password",
			"/api/posts/publish",
			"/api/posts/list",
		]);
		expect(document.paths["/api/posts/list"]).toHaveProperty("get");
		const op = document.paths["/api/users/change-password"]?.post as {
			operationId: string;
			deprecated: boolean;
		};
		expect(op.operationId).toBe("Users_changePassword");
		expect(op.deprecated).toBe(true);
	});

	const responsesOf = (path: string): Record<string, { content: object }> => {
		const post = document.paths[path]?.post as
			| { responses: Record<string, { content: object }> }
			| undefined;
		return post?.responses ?? {};
	};

	test("documents declared errors with the output statuses", () => {
		const responses = responsesOf("/api/users/register") as Record<
			string,
			{ content: object }
		>;
		expect(Object.keys(responses)).toEqual(["200", "400", "409", "500"]);
		expect(Object.keys(responses["409"]?.content ?? {})).toEqual([
			PROBLEM_MEDIA_TYPE,
		]);
		const publish = responsesOf("/api/posts/publish");
		expect(Object.keys(publish)).toEqual(["200", "400", "422", "500"]);
	});

	test("shares models as components and keeps secrets write-only", () => {
		expect(Object.keys(document.components.schemas)).toEqual([
			"User",
			"Post",
			"Problem",
		]);
		expect(
			document.components.schemas.User?.properties?.password,
		).toMatchObject({
			writeOnly: true,
		});
		expect(document.components.schemas.Post?.properties?.author).toEqual({
			$ref: "#/components/schemas/User",
		});
	});

	test("is available by name in the standard catalog", () => {
		const stage = StdStages.resolve("openapi", { info });
		expect(stage.kind).toBe("sink");
	});
});

describe("openapi sink errors", () => {
	const make = (options: object, commands = [Users, Posts]) =>
		outputOf({
			name: "Blog",
			commands,
			// biome-ignore lint/suspicious/noExplicitAny: invalid options on purpose
			pipe: [openapi(options as any)],
		});

	test("rejects invalid options when the stage is made", () => {
		expect(() => openapi({} as never)).toThrow(InvalidOutputStage);
		expect(() => openapi({ info, basePath: "api" })).toThrow(
			InvalidOutputStage,
		);
		expect(() => openapi({ info, extra: 1 } as never)).toThrow(
			InvalidOutputStage,
		);
		expect(() =>
			openapi({ info, route: { "Users.login": { method: "head" } } } as never),
		).toThrow(InvalidOutputStage);
	});

	test("rejects two operations on the same method and path", () => {
		const Api = make({
			info,
			route: { "Users.login": { path: "/users/register" } },
		});
		expect(() => Api.build()).toThrow(InvalidOutputStage);
	});

	test("rejects routes of unknown operations", () => {
		const Api = make({ info, route: { "Users.nope": { path: "/x" } } });
		expect(() => Api.build()).toThrow(InvalidOutputStage);
	});

	test("rejects get and delete operations with non scalar input", () => {
		const Api = make({
			info,
			route: { "Posts.publish": { method: "get" } },
		});
		expect(() => Api.build()).toThrow(InvalidOutputStage);
	});

	test("sends scalar input of get and delete as query parameters", async () => {
		const document = make({
			info,
			route: { "Users.login": { method: "delete" } },
		}).build();
		await validated(document);
		const operation = document.paths["/users/login"]?.delete as {
			parameters: { name: string; in: string; required: boolean }[];
		};
		expect(operation.parameters.map((p) => p.name)).toEqual([
			"email",
			"password",
		]);
	});
});

class GetEntry extends useCaseOf({
	name: "GetEntry",
	blueprint: blueprintOf((ctx) => ({
		slug: ctx.text({ description: "The entry's slug." }),
		draft: ctx.optional.boolean,
	})),
	response: blueprintOf((ctx) => ({ title: ctx.string })),
}) {
	override async execute() {
		return {} as never;
	}
}
class UpdateEntry extends useCaseOf({
	name: "UpdateEntry",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.text, title: ctx.text })),
	response: blueprintOf((ctx) => ({ title: ctx.string })),
}) {
	override async execute() {
		return {} as never;
	}
}
class RemoveEntry extends useCaseOf({
	name: "RemoveEntry",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.text })),
	response: blueprintOf(() => ({})),
}) {
	override async execute() {
		return {} as never;
	}
}
const Entries = commandOf({
	name: "Entries",
	useCases: { get: GetEntry, update: UpdateEntry, remove: RemoveEntry },
});

describe("openapi sink routes", () => {
	const document = outputOf({
		name: "Cms",
		commands: [Entries, Users],
		pipe: [
			openapi({
				info,
				basePath: "/api",
				route: {
					"Entries.get": { method: "get", path: "/entries/{slug}" },
					"Entries.update": { method: "patch", path: "/entries/{slug}" },
					"Entries.remove": {
						method: "delete",
						path: "/entries/{slug}",
						status: 204,
					},
					"Users.register": { path: "/users", status: 201 },
				},
				responses: {
					"Entries.get": {
						headers: { "cache-control": "public, max-age=60" },
					},
				},
				requestId: true,
				security: {
					schemes: {
						bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
						apiKey: { type: "apiKey", name: "x-api-key", in: "header" },
					},
					default: { scheme: "bearer" },
					operations: {
						"Entries.update": { scheme: "bearer", scopes: ["write"] },
						"Entries.get": false,
						"Users.login": { scheme: "apiKey" },
					},
				},
			}),
		],
	}).build();

	type Op = {
		parameters?: {
			name: string;
			in: string;
			required: boolean;
			description?: string;
			schema?: unknown;
		}[];
		requestBody?: { content: { "application/json": { schema: object } } };
		responses: Record<string, { headers?: object; content?: object }>;
		security?: unknown;
	};
	const op = (path: string, method: string) =>
		document.paths[path]?.[method] as Op;

	test("is a valid OpenAPI 3.1 document", async () => {
		await validated(document);
	});

	test("matches the snapshot", () => {
		expect(document).toMatchSnapshot();
	});

	test("path parameters are required and leave the query and the body", () => {
		const get = op("/api/entries/{slug}", "get");
		expect(get.parameters).toEqual([
			{
				name: "slug",
				in: "path",
				required: true,
				description: "The entry's slug.",
				schema: expect.objectContaining({ type: "string" }),
			},
			{
				name: "draft",
				in: "query",
				required: false,
				schema: { type: "boolean" },
			},
		]);
		const patch = op("/api/entries/{slug}", "patch");
		expect(patch.parameters?.map((p) => [p.name, p.in])).toEqual([
			["slug", "path"],
		]);
		const body = patch.requestBody?.content["application/json"].schema as {
			properties: object;
			required: string[];
		};
		expect(Object.keys(body.properties)).toEqual(["title"]);
		expect(body.required).toEqual(["title"]);
	});

	test("uses the declared status; 204 has no content", () => {
		expect(Object.keys(op("/api/users", "post").responses)).toEqual([
			"201",
			"400",
			"422",
			"500",
		]);
		const removed = op("/api/entries/{slug}", "delete").responses["204"];
		expect(removed).toBeDefined();
		expect(removed?.content).toBeUndefined();
		expect(op("/api/entries/{slug}", "delete").requestBody).toBeUndefined();
	});

	test("documents static headers and the request id", () => {
		const responses = op("/api/entries/{slug}", "get").responses;
		expect(responses["200"]?.headers).toEqual({
			"x-request-id": expect.objectContaining({ schema: { type: "string" } }),
			"cache-control": {
				schema: { type: "string", const: "public, max-age=60" },
			},
		});
		expect(Object.keys(responses["400"]?.headers ?? {})).toEqual([
			"x-request-id",
		]);
	});

	test("documents security schemes and requirements", () => {
		expect(document.components.securitySchemes).toEqual({
			bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
			apiKey: { type: "apiKey", name: "x-api-key", in: "header" },
		});
		expect(document.security).toEqual([{ bearer: [] }]);
		expect(op("/api/entries/{slug}", "patch").security).toEqual([
			{ bearer: ["write"] },
		]);
		expect(op("/api/entries/{slug}", "get").security).toEqual([]);
		expect(op("/api/users/login", "post").security).toEqual([{ apiKey: [] }]);
		expect(op("/api/entries/{slug}", "delete").security).toBeUndefined();
	});
});

describe("openapi sink route errors", () => {
	const make = (options: object, commands = [Entries, Posts]) =>
		outputOf({
			name: "Cms",
			commands,
			// biome-ignore lint/suspicious/noExplicitAny: invalid options on purpose
			pipe: [openapi({ info, ...options } as any)],
		});
	const route = (path: string, extra: object = {}) => ({
		route: { "Entries.get": { method: "get", path, ...extra } },
	});

	test("rejects malformed paths when the stage is made", () => {
		for (const path of [
			"/entries/:slug",
			"/entries/*",
			"/entries/{slug}.json",
			"/entries/{}",
			"/entries/{1slug}",
			"/entries/{slug}/{slug}",
			"/entries?x=1",
		]) {
			expect(() => openapi({ info, ...route(path) } as never)).toThrow(
				InvalidOutputStage,
			);
		}
		expect(() => openapi({ info, basePath: "/{tenant}" })).toThrow(
			InvalidOutputStage,
		);
	});

	test("rejects invalid status, headers, requestId and security", () => {
		for (const options of [
			route("/entries", { status: 203 }),
			{ responses: { "Entries.get": { headers: { "a b": "x" } } } },
			{ responses: { "Entries.get": { headers: { x: "a\r\nb" } } } },
			{ responses: { "Entries.get": { headers: { "Content-Type": "x" } } } },
			{ responses: { "Entries.get": { status: 201 } } },
			{ requestId: false },
			{ requestId: "x request" },
			{ security: { schemes: { b: { type: "magic" } } } },
			{ security: { schemes: { b: { type: "http" } } } },
			{ security: { schemes: { b: { type: "apiKey", name: "k", in: "x" } } } },
			{ security: { schemes: {}, default: { scheme: "nope" } } },
			{
				security: {
					schemes: { b: { type: "http", scheme: "bearer" } },
					operations: { "Entries.get": { scheme: "b", scopes: [1] } },
				},
			},
		]) {
			expect(() => openapi({ info, ...options } as never)).toThrow(
				InvalidOutputStage,
			);
		}
	});

	test("a path parameter must be a scalar key of the input", () => {
		expect(() => make(route("/entries/{nope}")).build()).toThrow(
			InvalidOutputStage,
		);
		expect(() =>
			make({
				route: { "Posts.publish": { path: "/posts/{author}" } },
			}).build(),
		).toThrow(InvalidOutputStage);
	});

	test("parameters with other names still collide", () => {
		expect(() =>
			make({
				route: {
					"Entries.get": { method: "get", path: "/entries/{slug}" },
					"Entries.remove": { method: "get", path: "/entries/{id}" },
				},
			}).build(),
		).toThrow(InvalidOutputStage);
	});

	test("responses and security name known operations", () => {
		expect(() =>
			make({ responses: { "Entries.nope": { headers: {} } } }).build(),
		).toThrow(InvalidOutputStage);
		expect(() =>
			make({
				security: {
					schemes: { b: { type: "http", scheme: "bearer" } },
					operations: { "Entries.nope": false },
				},
			}).build(),
		).toThrow(InvalidOutputStage);
	});
});
