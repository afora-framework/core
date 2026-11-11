import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { stageDescriptionOf } from "@afora/core/experimental";
import { Elysia } from "elysia";
import { type ElysiaHooks, type ElysiaOptions, elysia } from "../src/index";

class Whoami extends useCaseOf({
	name: "Whoami",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ tenant: ctx.optional.string })),
	context: blueprintOf((ctx) => ({ tenant: ctx.optional.string })),
	route: { method: "get", path: "/whoami" },
}) {
	override async execute() {
		return { tenant: this.context.tenant };
	}
}
const Api = commandOf({ name: "Api", useCases: { whoami: Whoami } });
const build = (options: ElysiaOptions = {}, hooks?: ElysiaHooks) =>
	outputOf({
		name: "Api",
		commands: [Api],
		pipe: [elysia(options, hooks)],
	}).build();
const get = (
	app: { handle(request: Request): Promise<Response> },
	path: string,
	headers = {},
) => app.handle(new Request(`http://test${path}`, { headers }));

describe("elysia sink: hooks", () => {
	test("middlewares are plugins, used before the routes", async () => {
		const order: string[] = [];
		const app = build(
			{ context: { variables: { tenant: "tenant" } } },
			{
				middlewares: [
					(instance) =>
						instance
							.derive("global", () => {
								order.push("first");
								return { tenant: "acme" };
							})
							.onBeforeHandle("global", ({ request, status }) => {
								order.push("second");
								if (request.headers.get("x-block")) {
									return status(429, "blocked");
								}
							}),
				],
			},
		);
		const served = await get(app, "/whoami");
		expect(await served.json()).toEqual({ tenant: "acme" });
		expect(order).toEqual(["first", "second"]);
		const blocked = await get(app, "/whoami", { "x-block": "1" });
		expect(blocked.status).toBe(429);
	});

	test("routes can be added to an app, which keeps its handlers", async () => {
		const mine = new Elysia()
			.onError(() => new Response("mine", { status: 404 }))
			.get("/health", () => "ok");
		const app = build({}, { app: mine });
		expect(await (await get(app, "/health")).text()).toBe("ok");
		expect(await (await get(app, "/nowhere")).text()).toBe("mine");
		expect((await get(app, "/whoami")).status).toBe(200);
	});

	test("options are checked, and hooks are not described", () => {
		expect(() => elysia({ nope: true } as never)).toThrow();
		expect(() => elysia({ basePath: 1 } as never)).toThrow();
		expect(stageDescriptionOf(elysia({ basePath: "/api" }, {}))).toEqual({
			kind: "sink",
			name: "elysia",
			options: { basePath: "/api" },
		});
	});
});
