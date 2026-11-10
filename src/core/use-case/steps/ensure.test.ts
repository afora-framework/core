import { describe, expect, test } from "bun:test";
import { ExceptionLayers, exceptionOf } from "../../../index";
import {
	InvalidCredentials,
	invalidStep,
	sample,
	stepsCase,
	UserAlreadyExists,
} from "./steps.fixtures";

const Code = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Code",
	message: ({ code }: { code: number }) => `code ${code}`,
});

/** A use case that ensures `kind` of `value` (and `other`) and returns; `$nothing` is `undefined`. */
function ensuring(
	kind: string,
	value: unknown,
	other?: unknown,
	extra: object = {},
) {
	return stepsCase({
		errors: [InvalidCredentials, Code],
		steps: [
			{ run: "nothing", fn: () => undefined, as: "nothing" },
			{
				ensure: kind,
				value,
				...(other === undefined ? {} : { other }),
				error: InvalidCredentials,
				...extra,
			},
			{ return: {} },
		],
	});
}

const passes = async (Case: ReturnType<typeof ensuring>) =>
	(await new Case(sample).execute().then(
		() => true,
		() => false,
	)) as boolean;

describe("ensure", () => {
	test("exists and absent treat undefined and null alike", async () => {
		expect(await passes(ensuring("exists", "$input.name"))).toBe(true);
		expect(await passes(ensuring("exists", "$nothing"))).toBe(false);
		expect(await passes(ensuring("exists", { literal: null }))).toBe(false);
		expect(await passes(ensuring("absent", "$nothing"))).toBe(true);
		expect(await passes(ensuring("absent", "$input.name"))).toBe(false);
	});

	test("true and false are strict", async () => {
		expect(await passes(ensuring("true", true))).toBe(true);
		expect(await passes(ensuring("true", 1))).toBe(false);
		expect(await passes(ensuring("false", false))).toBe(true);
		expect(await passes(ensuring("false", null))).toBe(false);
	});

	test("equals and notEquals are structural, as in queries", async () => {
		expect(
			await passes(
				ensuring("equals", { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
			),
		).toBe(true);
		expect(await passes(ensuring("equals", [1, 2], [2, 1]))).toBe(false);
		expect(await passes(ensuring("equals", "$input.name", "Ana"))).toBe(true);
		expect(await passes(ensuring("notEquals", "$input.name", "Bob"))).toBe(
			true,
		);
		expect(await passes(ensuring("notEquals", "Ana", "Ana"))).toBe(false);
	});

	test("failure throws the error with the use case as source and the resolved details", async () => {
		const Case = stepsCase({
			errors: [Code],
			steps: [
				{
					ensure: "false",
					value: true,
					error: Code,
					details: { code: 7 },
				},
				{ return: {} },
			],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.is(Code)).toBe(true);
		expect(error.source).toBe("Case");
		expect(error.find(Code).details).toEqual({ code: 7 });
		expect(error.message).toBe("code 7");
	});

	test("declaration rules", () => {
		const declare = (step: object, errors: unknown[] = [UserAlreadyExists]) =>
			invalidStep(() => stepsCase({ errors, steps: [step, { return: {} }] }));
		const ok = { value: 1, error: UserAlreadyExists };
		expect(declare({ ensure: "equals", ...ok })).toMatchObject({
			index: 0,
			code: "invalid_step",
		});
		expect(declare({ ensure: "exists", ...ok, other: 1 }).code).toBe(
			"invalid_step",
		);
		expect(declare({ ensure: "maybe", ...ok }).code).toBe("invalid_step");
		expect(declare({ ensure: "exists", ...ok }, []).code).toBe(
			"undeclared_error",
		);
		expect(declare({ ensure: "exists", value: 1, error: Error }).code).toBe(
			"undeclared_error",
		);
		expect(declare({ ensure: "exists", error: UserAlreadyExists }).code).toBe(
			"invalid_step",
		);
		expect(declare({ ensure: "exists", ...ok, extra: 1 }).code).toBe(
			"invalid_step",
		);
	});
});
