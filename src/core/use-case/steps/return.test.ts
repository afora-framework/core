import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../../index";
import { invalidStep, sample, stepsCase } from "./steps.fixtures";

const fn = () => 1;

describe("return", () => {
	test("the response is validated by the response blueprint", async () => {
		const response = blueprintOf((ctx) => ({ n: ctx.integer }));
		const ok = stepsCase({ response, steps: [{ return: { n: 1 } }] });
		expect(await new ok(sample).execute()).toEqual({ n: 1 });
		const bad = stepsCase({ response, steps: [{ return: { n: "x" } }] });
		const error = await new bad(sample).execute().catch((e) => e);
		expect(error.name).toBe("InvalidUseCaseResponse");
	});

	test("it must be the last step, exactly once", () => {
		const declare = (...steps: object[]) =>
			invalidStep(() => stepsCase({ steps }));
		expect(declare({ return: {} }, { return: {} })).toMatchObject({
			index: 0,
			code: "misplaced_return",
		});
		expect(declare({ return: {} }, { run: "a", fn })).toMatchObject({
			index: 0,
			code: "misplaced_return",
		});
	});

	test("a missing return is rejected", () => {
		expect(
			invalidStep(() => stepsCase({ steps: [{ run: "a", fn }] })),
		).toMatchObject({ index: 1, code: "missing_return" });
		expect(invalidStep(() => stepsCase({ steps: [] })).code).toBe(
			"missing_return",
		);
		expect(invalidStep(() => stepsCase({ steps: "x" as never })).code).toBe(
			"missing_return",
		);
	});
});
