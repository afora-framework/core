import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { stageDescriptionOf } from "@afora/core/experimental";
import createExpress, { type Express } from "express";
import { type ExpressHooks, type ExpressOptions, express } from "../src/index";

class Whoami extends useCaseOf({
	name: "Whoami",
	blueprint: blueprintOf((ctx) => ({ note: ctx.optional.string })),
	response: blueprintOf((ctx) => ({
		tenant: ctx.optional.string,
		note: ctx.optional.string,
	})),
	context: blueprintOf((ctx) => ({ tenant: ctx.optional.string })),
	route: { method: "post", path: "/whoami" },
}) {
	override async execute() {
		return { tenant: this.context.tenant, note: this.input.note };
	}
}
const Api = commandOf({ name: "Api", useCases: { whoami: Whoami } });
const build = (options: ExpressOptions = {}, hooks?: ExpressHooks) =>
	outputOf({
		name: "Api",
		commands: [Api],
		pipe: [express(options, hooks)],
	}).build();

const open: Server[] = [];
afterEach(() => {
	for (const server of open.splice(0)) server.close();
});
async function call(
	app: Express,
	path: string,
	init: RequestInit = { method: "POST" },
) {
	const server = await new Promise<Server>((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	open.push(server);
	const { port } = server.address() as AddressInfo;
	return fetch(`http://127.0.0.1:${port}${path}`, init);
}

class Upload extends useCaseOf({
	name: "Upload",
	blueprint: blueprintOf((ctx) => ({ file: ctx.file })),
	response: blueprintOf((ctx) => ({ size: ctx.integer })),
	route: { method: "post", path: "/upload" },
}) {
	override async execute() {
		return { size: this.input.file.size };
	}
}

describe("express sink: a multipart body", () => {
	const app = (parser?: ReturnType<typeof createExpress.text>) => {
		const mine = createExpress();
		if (parser) mine.use(parser);
		return outputOf({
			name: "Media",
			commands: [commandOf({ name: "Media", useCases: { upload: Upload } })],
			pipe: [express({}, { app: mine })],
		}).build();
	};
	const body = () => {
		const form = new FormData();
		form.append("file", new File(["abc"], "a.txt", { type: "text/plain" }));
		return form;
	};

	test("is read from the stream, or from the bytes of express.raw()", async () => {
		for (const parser of [undefined, createExpress.raw({ type: "*/*" })]) {
			const served = await call(app(parser), "/upload", {
				method: "POST",
				body: body(),
			});
			expect(served.status).toBe(200);
			expect(await served.json()).toEqual({ size: 3 });
		}
	});

	test("already read by another parser is a 500 MultipartBodyAlreadyRead", async () => {
		const served = await call(
			app(createExpress.text({ type: "*/*" })),
			"/upload",
			{
				method: "POST",
				body: body(),
			},
		);
		expect(served.status).toBe(500);
		expect(((await served.json()) as { title: string }).title).toBe(
			"MultipartBodyAlreadyRead",
		);
	});
});

describe("express sink: hooks", () => {
	test("middlewares run before the routes, and may answer", async () => {
		const order: string[] = [];
		const app = build(
			{ context: { variables: { tenant: "tenant" } } },
			{
				middlewares: [
					(_request, response, next) => {
						order.push("first");
						response.locals.tenant = "acme";
						next();
					},
					(request, response, next) => {
						order.push("second");
						if (request.get("x-block")) response.status(429).end("blocked");
						else next();
					},
				],
			},
		);
		const served = await call(app, "/whoami");
		expect(await served.json()).toEqual({ tenant: "acme" });
		expect(order).toEqual(["first", "second"]);
		const blocked = await call(app, "/whoami", {
			method: "POST",
			headers: { "x-block": "1" },
		});
		expect(blocked.status).toBe(429);
	});

	test("routes can be added to an app, behind its own parser and handlers", async () => {
		const mine = createExpress();
		mine.use(createExpress.json());
		mine.get("/health", (_request, response) => {
			response.end("ok");
		});
		const app = build({}, { app: mine });
		expect(app).toBe(mine);
		mine.use((_request, response) => {
			response.status(404).end("mine");
		});
		expect(await (await call(app, "/health", {})).text()).toBe("ok");
		expect(await (await call(app, "/nowhere", {})).text()).toBe("mine");
		const parsed = await call(app, "/whoami", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ note: "n" }),
		});
		expect(await parsed.json()).toEqual({ note: "n" });
	});

	test("options are checked, and hooks are not described", () => {
		expect(() => express({ nope: true } as never)).toThrow();
		expect(() => express({ basePath: 1 } as never)).toThrow();
		expect(stageDescriptionOf(express({ basePath: "/api" }, {}))).toEqual({
			kind: "sink",
			name: "express",
			options: { basePath: "/api" },
		});
	});
});
