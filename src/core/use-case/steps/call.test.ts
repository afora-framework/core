import { describe, expect, test } from "bun:test";
import { blueprintOf, useCaseOf } from "../../../index";
import {
	Empty,
	invalidStep,
	registerOf,
	sample,
	stepsCase,
	User,
	usersRepository,
} from "./steps.fixtures";

describe("call", () => {
	test("runs the child through its dependency function and binds the response", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		const Case = stepsCase({
			dependencies: { register: Register },
			response: blueprintOf(() => ({ user: User })),
			steps: [
				{ call: "register", input: "$input", as: "done" },
				{ return: { user: "$done.user" } },
			],
		});
		const instance = new Case(sample);
		const { user } = (await instance.execute()) as { user: User };
		expect((await Users.findById(user.id))?.email).toBe(sample.email);
		expect(instance.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("the child validates its input", async () => {
		const Case = stepsCase({
			dependencies: { register: registerOf(usersRepository()) },
			steps: [{ call: "register", input: { name: "x" } }, { return: {} }],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.name).toBe("InvalidUseCaseInput");
	});

	test("execute can override the child like any use case dependency", async () => {
		const Child = class extends useCaseOf({
			name: "Child",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({ n: ctx.integer })),
			steps: [{ return: { n: 1 } }],
		}) {};
		const Case = stepsCase({
			dependencies: { child: Child },
			response: blueprintOf((ctx) => ({ n: ctx.integer })),
			steps: [{ call: "child", input: {}, as: "r" }, { return: { n: "$r.n" } }],
		});
		expect(await new Case(sample).execute()).toEqual({ n: 1 });
		expect(
			await new Case(sample).execute({ child: async () => ({ n: 2 }) }),
		).toEqual({ n: 2 });
	});

	test("declaration rules", () => {
		const Users = usersRepository();
		const declare = (step: object) =>
			invalidStep(() =>
				stepsCase({
					dependencies: { users: Users },
					steps: [step, { return: {} }],
				}),
			);
		expect(declare({ call: "users", input: {} }).code).toBe(
			"unknown_dependency",
		);
		expect(declare({ call: "nope", input: {} }).code).toBe(
			"unknown_dependency",
		);
		expect(declare({ call: "users" }).code).toBe("invalid_step");
	});
});
