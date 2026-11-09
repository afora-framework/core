import { describe, expect, test } from "bun:test";
import {
	invalidStep,
	sample,
	stepsCase,
	User,
	UserResponse,
} from "./steps.fixtures";

const values = { name: "$input.name", email: "$input.email", password: "h" };

describe("build", () => {
	test("constructs the class with the resolved values", async () => {
		const Case = stepsCase({
			response: UserResponse,
			steps: [
				{ build: User, values, as: "user" },
				{ return: { user: "$user" } },
			],
		});
		const { user } = (await new Case(sample).execute()) as { user: User };
		expect(user).toBeInstanceOf(User);
		expect(user.name).toBe("Ana");
	});

	test("invalid values throw as in a hand-written new", async () => {
		const Case = stepsCase({
			response: UserResponse,
			steps: [
				{ build: User, values: { ...values, email: "no" }, as: "user" },
				{ return: { user: "$user" } },
			],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.source).toBeDefined();
		expect(error.message).toMatch(/email|invalid/i);
	});

	test("declaration rules", () => {
		const declare = (step: object) =>
			invalidStep(() => stepsCase({ steps: [step, { return: {} }] }));
		expect(declare({ build: class {}, values, as: "u" }).code).toBe(
			"invalid_class",
		);
		expect(declare({ build: "User", values, as: "u" }).code).toBe(
			"invalid_class",
		);
		expect(declare({ build: User, values }).code).toBe("invalid_step");
		expect(declare({ build: User, values: [1], as: "u" }).code).toBe(
			"invalid_step",
		);
		expect(declare({ build: User, values: "plain", as: "u" }).code).toBe(
			"invalid_step",
		);
	});
});
