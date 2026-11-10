import { describe, expect, test } from "bun:test";
import { blueprintOf, InvalidUseCaseStep } from "../../../index";
import { isExportedException } from "../../exception/exported";
import {
	invalidStep,
	registerOf,
	stepsCase,
	usersRepository,
} from "./steps.fixtures";

const declare = (...steps: unknown[]) =>
	invalidStep(() => stepsCase({ steps: [...steps, { return: {} }] }));

describe("InvalidUseCaseStep", () => {
	test("is a use case exception that the package exports", () => {
		expect(isExportedException(InvalidUseCaseStep)).toBe(true);
		expect(String(InvalidUseCaseStep.layer)).toBe("use-case");
	});

	test("carries the source, the index and the reason", () => {
		let thrown: { source: string; details: object } | undefined;
		try {
			stepsCase({ steps: [{ nope: 1 }, { return: {} }] });
		} catch (error) {
			thrown = error as never;
		}
		expect(thrown?.source).toBe("Case");
		expect(thrown?.details).toMatchObject({
			index: 0,
			reason: expect.any(String),
		});
	});
});

describe("steps declaration rules", () => {
	test("steps must be a non-empty list of objects", () => {
		expect(invalidStep(() => stepsCase({ steps: [] })).code).toBe(
			"missing_return",
		);
		expect(declare("find").code).toBe("unknown_step");
		expect(declare(null).code).toBe("unknown_step");
		expect(declare([]).code).toBe("unknown_step");
	});

	test("unknown kinds and steps with two kinds", () => {
		expect(declare({ nope: 1 })).toMatchObject({
			index: 0,
			code: "unknown_step",
		});
		expect(declare({ return: 1, run: "a" }).code).toBe("unknown_step");
	});

	test("missing and extra fields", () => {
		expect(declare({ run: "a" }).code).toBe("invalid_step");
		expect(declare({ build: undefined, values: {}, as: "a" }).code).toBe(
			"invalid_step",
		);
		expect(declare({ return: 1, as: "a" }).code).toBe("invalid_step");
	});

	test("the dependencies of find, create and call must be of their kind", () => {
		const Users = usersRepository();
		expect(
			invalidStep(() =>
				stepsCase({
					dependencies: { users: Users, register: registerOf(Users) },
					steps: [{ find: "register.findById" }, { return: {} }],
				}),
			).code,
		).toBe("unknown_dependency");
	});

	test("steps are validated against the blueprint of the use case", () => {
		expect(
			invalidStep(() =>
				stepsCase({
					blueprint: blueprintOf((ctx) => ({ a: ctx.string })),
					steps: [{ return: "$input.b" }],
				}),
			).code,
		).toBe("unknown_key");
	});
});
