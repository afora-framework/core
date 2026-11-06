import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../../index";
import { invalidStep, sample, stepsCase } from "./steps.fixtures";

describe("run", () => {
	test("awaits fn with the resolved args and the context last", async () => {
		const seen: unknown[][] = [];
		const Case = stepsCase({
			context: blueprintOf((ctx) => ({ tenant: ctx.string })),
			response: blueprintOf((ctx) => ({ out: ctx.string })),
			steps: [
				{
					run: "shout",
					fn: async (...args: unknown[]) => {
						seen.push(args);
						return String(args[0]).toUpperCase();
					},
					args: ["$input.name", { n: 1 }],
					as: "loud",
				},
				{ return: { out: "$loud" } },
			],
		});
		expect(
			await new Case(sample, { context: { tenant: "acme" } }).execute(),
		).toEqual({ out: "ANA" });
		expect(seen).toEqual([["Ana", { n: 1 }, { context: { tenant: "acme" } }]]);
	});

	test("without a context fn gets an undefined one", async () => {
		let received: unknown = "unset";
		const Case = stepsCase({
			steps: [
				{
					run: "peek",
					fn: (options: { context: unknown }) => {
						received = options.context;
					},
				},
				{ return: {} },
			],
		});
		await new Case(sample).execute();
		expect(received).toBeUndefined();
	});

	test("errors of fn propagate with the use case frame", async () => {
		const Case = stepsCase({
			steps: [
				{
					run: "boom",
					fn: () => {
						throw new Error("boom");
					},
				},
				{ return: {} },
			],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.message).toBe("boom");
		expect(error.layer).toBe("use-case");
		expect(error.source).toBe("Case");
	});

	test("declaration rules", () => {
		const fn = () => 1;
		const declare = (...steps: object[]) =>
			invalidStep(() => stepsCase({ steps: [...steps, { return: {} }] }));
		expect(declare({ run: "a", fn }, { run: "a", fn })).toMatchObject({
			index: 1,
			code: "invalid_step_name",
		});
		expect(declare({ run: "1a", fn }).code).toBe("invalid_step_name");
		expect(declare({ run: "a" }).code).toBe("invalid_step");
		expect(declare({ run: "a", fn: "x" }).code).toBe("invalid_step");
	});
});
