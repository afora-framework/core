import { describe, expect, test } from "bun:test";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { operationRoutes } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	InvalidOutputStage,
	InvalidUseCaseDeclaration,
	listOf,
	openapi,
	outputOf,
	Route,
	useCaseOf,
} from "../../index";

const ListInput = blueprintOf((ctx) => ({
	slug: ctx.slug,
	page: ctx.integer,
	locale: ctx.optional.text,
	session: ctx.text,
	title: ctx.text,
	tags: listOf(ctx.text),
}));
const Listed = blueprintOf((ctx) => ({ total: ctx.integer }));

@Route("PUT", "/posts/{slug}", {
	status: 202,
	query: ["page"],
	headers: { locale: "Accept-Language" },
	cookie: { session: "sid" },
})
class Decorated extends useCaseOf({
	name: "Decorated",
	blueprint: ListInput,
	response: Listed,
}) {
	override async execute() {
		return { total: 0 };
	}
}

class Declared extends useCaseOf({
	name: "Declared",
	blueprint: blueprintOf((ctx) => ({ id: ctx.id, page: ctx.integer })),
	response: Listed,
	route: { method: "GET", path: "/items/{id}" },
}) {
	override async execute() {
		return { total: 0 };
	}
}

class Plain extends useCaseOf({
	name: "Plain",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text })),
	response: Listed,
}) {
	override async execute() {
		return { total: 0 };
	}
}

const Posts = commandOf({
	name: "Posts",
	useCases: { change: Decorated, get: Declared, plain: Plain },
});
const info = { title: "Blog", version: "1.0.0" };
const reasonOf = (run: () => unknown): string => {
	try {
		run();
	} catch (error) {
		return (error as { details: { reason: string } }).details.reason;
	}
	throw new Error("did not throw");
};

describe("route declaration", () => {
	test("the setting and the decorator give the same frozen data", () => {
		expect(Decorated.route).toEqual({
			method: "put",
			path: "/posts/{slug}",
			status: 202,
			query: ["page"],
			headers: { locale: "accept-language" },
			cookie: { session: "sid" },
		});
		expect(Declared.route).toEqual({ method: "get", path: "/items/{id}" });
		expect(Object.isFrozen(Decorated.route)).toBe(true);
		expect(Plain.route).toBeUndefined();
	});

	test("the second argument of @Route may be the options", () => {
		@Route("delete", { query: ["page"] })
		class Remove extends useCaseOf({
			name: "Remove",
			blueprint: blueprintOf((ctx) => ({ page: ctx.integer })),
			response: Listed,
		}) {
			override async execute() {
				return { total: 0 };
			}
		}
		expect(Remove.route).toEqual({ method: "delete", query: ["page"] });
	});

	test("a subclass and an application see the route of the class", () => {
		class Child extends Decorated {}
		expect(Child.route).toBe(Decorated.route);
		const app = applicationOf({
			name: "blog",
			useCases: { Decorated, Declared, Plain },
			commands: { Posts },
		});
		const described = app.describe().useCases;
		expect(described.Decorated?.route).toEqual(Decorated.route);
		expect(described.Declared?.route).toEqual({
			method: "get",
			path: "/items/{id}",
		});
		expect(described.Plain).not.toHaveProperty("route");
		expect(JSON.parse(JSON.stringify(described.Decorated)).route.method).toBe(
			"put",
		);
	});

	test("rejects a route that does not fit the input", () => {
		const declare = (route: unknown) => () =>
			useCaseOf({
				name: "Bad",
				blueprint: ListInput,
				response: Listed,
				route: route as never,
			});
		expect(declare({ method: "head" })).toThrow(InvalidUseCaseDeclaration);
		expect(reasonOf(declare({ method: "get", verb: 1 }))).toContain(
			'no option "verb"',
		);
		expect(reasonOf(declare({ method: "get", path: "/x/:slug" }))).toContain(
			"route.path",
		);
		expect(reasonOf(declare({ method: "get", path: "/x/{nope}" }))).toContain(
			"not a scalar key of the input",
		);
		expect(reasonOf(declare({ method: "post", query: ["tags"] }))).toContain(
			'"tags" from the query',
		);
		expect(
			reasonOf(declare({ method: "post", path: "/x/{slug}", query: ["slug"] })),
		).toContain("from two places: the path and the query");
		expect(
			reasonOf(declare({ method: "post", headers: { locale: "bad name" } })),
		).toContain("the name of a header");
		expect(
			reasonOf(
				declare({
					method: "post",
					headers: { locale: "X-A", title: "x-a" },
				}),
			),
		).toContain("into two input keys");
		expect(reasonOf(declare({ method: "post", status: 500 }))).toContain(
			"route.status",
		);
	});

	test("@Route rejects other classes and a second route", () => {
		expect(() => Route("GET")(class {})).toThrow(InvalidUseCaseDeclaration);
		expect(reasonOf(() => Route("GET")(Declared))).toContain(
			"already has a route",
		);
		expect(reasonOf(() => Route("GET", "/x/{nope}")(Plain))).toContain(
			"not a scalar key",
		);
		expect(Plain.route).toBeUndefined();
	});
});

describe("routes of operations", () => {
	test("the use case route is the default and the sink option wins", () => {
		const operations = outputOf({ name: "Api", commands: [Posts] }).operations;
		const routes = operationRoutes(operations, { basePath: "/api" });
		expect(routes.get("Posts.change")).toEqual({
			method: "put",
			path: "/api/posts/{slug}",
			parameters: ["slug"],
			status: 202,
			headers: {},
			body: true,
			query: ["page"],
			requestHeaders: { locale: "accept-language" },
			cookies: { session: "sid" },
		});
		expect(routes.get("Posts.get")).toMatchObject({
			method: "get",
			path: "/api/items/{id}",
			body: false,
		});
		expect(routes.get("Posts.plain")).toMatchObject({
			method: "post",
			path: "/api/posts/plain",
			status: 200,
			query: [],
		});
		const changed = operationRoutes(operations, {
			route: { "Posts.change": { method: "patch", path: "/p/{slug}" } },
		});
		expect(changed.get("Posts.change")).toMatchObject({
			method: "patch",
			path: "/p/{slug}",
			status: 202,
			cookies: { session: "sid" },
		});
	});

	test("one routed use case in two commands collides, naming both", () => {
		const Other = commandOf({ name: "Other", useCases: { get: Declared } });
		const reason = reasonOf(() =>
			operationRoutes(
				outputOf({ name: "Api", commands: [Posts, Other] }).operations,
				{},
			),
		);
		expect(reason).toContain("Posts.get and Other.get");
		expect(
			operationRoutes(
				outputOf({ name: "Api", commands: [Posts, Other] }).operations,
				{ route: { "Other.get": { path: "/other/{id}" } } },
			).get("Other.get")?.path,
		).toBe("/other/{id}");
	});

	test("a sink path cannot take a key the route reads elsewhere", () => {
		expect(() =>
			operationRoutes(outputOf({ name: "Api", commands: [Posts] }).operations, {
				route: { "Posts.change": { path: "/p/{page}" } },
			}),
		).toThrow(InvalidOutputStage);
	});
});

describe("openapi document of routed use cases", () => {
	const document = outputOf({
		name: "Api",
		commands: [Posts],
		pipe: [openapi({ info })],
	}).build();

	test("is a valid OpenAPI 3.1 document", async () => {
		const result = await new Validator().validate(
			document as unknown as SpecData,
		);
		expect(result.errors ?? []).toEqual([]);
		expect(result.valid).toBe(true);
	});

	test("documents each key where the route reads it", () => {
		const change = document.paths["/posts/{slug}"]?.put as {
			parameters: { name: string; in: string; required: boolean }[];
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: object; required: string[] };
					};
				};
			};
			responses: Record<string, unknown>;
		};
		expect(
			change.parameters.map(({ name, in: where, required }) => [
				name,
				where,
				required,
			]),
		).toEqual([
			["slug", "path", true],
			["page", "query", true],
			["accept-language", "header", false],
			["sid", "cookie", true],
		]);
		const body = change.requestBody.content["application/json"].schema;
		expect(Object.keys(body.properties)).toEqual(["title", "tags"]);
		expect(body.required).toEqual(["title", "tags"]);
		expect(Object.keys(change.responses)).toContain("202");
		const get = document.paths["/items/{id}"]?.get as {
			parameters: { name: string; in: string }[];
		};
		expect(get.parameters.map(({ name, in: where }) => [name, where])).toEqual([
			["id", "path"],
			["page", "query"],
		]);
	});
});
