import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../../index";
import {
	hashPassword,
	invalidStep,
	sample,
	stepsCase,
	User,
} from "./steps.fixtures";

const build = {
	build: User,
	values: {
		name: "$input.name",
		email: "$input.email",
		password: hashPassword("p"),
	},
	as: "user",
};

describe("invoke", () => {
	test("calls a public method with resolved args and binds its result", async () => {
		const Case = stepsCase({
			response: blueprintOf((ctx) => ({ text: ctx.string, ok: ctx.boolean })),
			steps: [
				build,
				{ invoke: "$user", method: "greet", args: ["Hello"], as: "text" },
				{
					invoke: "$user",
					method: "matches",
					args: ["$input.plainPassword"],
					as: "ok",
				},
				{ return: { text: "$text", ok: "$ok" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({
			text: "Hello, Ana",
			ok: true,
		});
	});

	test("awaits an async method", async () => {
		class Later extends User {
			async later(value: string) {
				return `${value}!`;
			}
		}
		const Case = stepsCase({
			response: blueprintOf((ctx) => ({ text: ctx.string })),
			steps: [
				{ ...build, build: Later },
				{ invoke: "$user", method: "later", args: ["hi"], as: "text" },
				{ return: { text: "$text" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({ text: "hi!" });
	});

	test("rejects non-records, missing methods and protected members at execution", async () => {
		const attempt = async (step: object) => {
			const Case = stepsCase({ steps: [build, step, { return: {} }] });
			return new Case(sample).execute().catch((e) => e);
		};
		for (const step of [
			{ invoke: "$input.name", method: "greet" },
			{ invoke: "$user", method: "missing" },
			{ invoke: "$user", method: "set" },
			{ invoke: "$user", method: "emit" },
			{ invoke: "$user", method: "constructor" },
			{ invoke: "$user", method: "name" },
		]) {
			const error = await attempt(step);
			expect(error.name).toBe("InvalidUseCaseStep");
		}
	});

	test("declaration rules", () => {
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [build, { invoke: "$user" }, { return: {} }],
				}),
			).code,
		).toBe("invalid_step");
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [build, { invoke: "$later", method: "x" }, { return: {} }],
				}),
			).code,
		).toBe("unbound_reference");
	});
});
