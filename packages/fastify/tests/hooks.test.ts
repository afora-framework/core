import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { stageDescriptionOf } from "@afora/core/experimental";
import Fastify from "fastify";
import { type FastifyHooks, type FastifyOptions, fastify } from "../src/index";

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
const build = (options: FastifyOptions = {}, hooks?: FastifyHooks) =>
	outputOf({
		name: "Api",
		commands: [Api],
		pipe: [fastify(options, hooks)],
	}).build();

describe("fastify sink: hooks", () => {
	test("middlewares are onRequest hooks, and may answer", async () => {
		const order: string[] = [];
		const app = build(
			{ context: { variables: { tenant: "tenant" } } },
			{
				middlewares: [
					async (request) => {
						order.push("first");
						(request as unknown as { tenant: string }).tenant = "acme";
					},
					async (request, reply) => {
						order.push("second");
						if (request.headers["x-block"]) {
							return reply.code(429).send("blocked");
						}
					},
				],
			},
		);
		const served = await app.inject({ method: "GET", url: "/whoami" });
		expect(served.json()).toEqual({ tenant: "acme" });
		expect(order).toEqual(["first", "second"]);
		const blocked = await app.inject({
			method: "GET",
			url: "/whoami",
			headers: { "x-block": "1" },
		});
		expect(blocked.statusCode).toBe(429);
		await app.close();
	});

	test("routes can be added to an instance, which keeps its handlers and parsers", async () => {
		const mine = Fastify();
		mine.post("/echo", (request) => ({ got: request.body }));
		mine.setNotFoundHandler((_request, reply) => reply.code(404).send("mine"));
		const app = build({}, { app: mine });
		expect(app).toBe(mine);
		expect(
			(await app.inject({ method: "GET", url: "/whoami" })).statusCode,
		).toBe(200);
		expect((await app.inject({ method: "GET", url: "/nowhere" })).body).toBe(
			"mine",
		);
		const echoed = await app.inject({
			method: "POST",
			url: "/echo",
			payload: { a: 1 },
		});
		expect(echoed.json()).toEqual({ got: { a: 1 } });
		await app.close();
	});

	test("options are checked, and hooks are not described", () => {
		expect(() => fastify({ nope: true } as never)).toThrow();
		expect(() => fastify({ basePath: 1 } as never)).toThrow();
		expect(stageDescriptionOf(fastify({ basePath: "/api" }, {}))).toEqual({
			kind: "sink",
			name: "fastify",
			options: { basePath: "/api" },
		});
	});
});
