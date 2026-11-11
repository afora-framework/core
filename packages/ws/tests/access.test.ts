import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import {
	type WebSocketEndpoint,
	type WebSocketHooks,
	websocket,
} from "../src/index";

class Remove extends useCaseOf({
	name: "Remove",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf((ctx) => ({ by: ctx.string })),
	context: blueprintOf((ctx) => ({ userId: ctx.string })),
	access: { scopes: ["notes:write"], context: { userId: "subject" } },
}) {
	override async execute() {
		return { by: this.context.userId };
	}
}
const Notes = commandOf({ name: "Notes", useCases: { remove: Remove } });
const build = (hooks?: WebSocketHooks) =>
	outputOf({
		name: "Notes",
		commands: [Notes],
		pipe: [websocket({}, hooks)],
	}).build() as WebSocketEndpoint;
const message = { id: 1, op: "Notes.remove", input: { id: "n1" } };
const writer = { subject: "u1", scopes: ["notes:write"] };

describe("websocket sink: access", () => {
	test("without a caller, an operation with an access is closed", async () => {
		const reply = await build().handle(message);
		expect(reply).toMatchObject({
			id: 1,
			problem: { title: "Unauthenticated", status: 401 },
		});
	});

	test("the caller is the principal given, else what the authenticator finds", async () => {
		expect(await build().handle(message, { principal: writer })).toEqual({
			id: 1,
			value: { by: "u1" },
		});
		expect(
			await build().handle(message, {
				principal: { subject: "u2", scopes: [] },
			}),
		).toMatchObject({ problem: { title: "Forbidden", status: 403 } });
		const endpoint = build({
			authenticator: (request) =>
				request.header("token") === "t" ? writer : null,
		});
		expect(await endpoint.handle(message, { values: { token: "t" } })).toEqual({
			id: 1,
			value: { by: "u1" },
		});
		expect(
			await endpoint.handle(message, { values: { token: "x" } }),
		).toMatchObject({ problem: { status: 401 } });
	});

	test("a session keeps the principal of its upgrade", async () => {
		const sent: string[] = [];
		const session = build().session(
			{ send: (data: string) => sent.push(data) } as never,
			{ principal: writer },
		);
		await session.message(JSON.stringify(message));
		expect(JSON.parse(sent[0] as string)).toEqual({
			id: 1,
			value: { by: "u1" },
		});
	});
});
