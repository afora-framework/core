import { describe, expect, test } from "bun:test";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
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
	PROBLEM_MEDIA_TYPE,
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
