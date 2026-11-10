import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../../index";
import {
	invalidStep,
	sample,
	seedUser,
	stepsCase,
	usersRepository,
} from "./steps.fixtures";

describe("find", () => {
	test("calls a read action with the resolved args and binds the result", async () => {
		const Users = usersRepository();
		const saved = await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			response: blueprintOf((ctx) => ({ id: ctx.string })),
			steps: [
				{ find: "users.findByEmail", args: ["$input.email"], as: "found" },
				{ return: { id: "$found.id" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({ id: saved.id });
	});

	test("takes no args for findMany, count and exists", async () => {
		const Users = usersRepository();
		await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			response: blueprintOf((ctx) => ({
				total: ctx.integer,
				email: ctx.string,
			})),
			steps: [
				{ find: "users.count", as: "total" },
				{ find: "users.findMany", as: "items" },
				{ return: { total: "$total", email: "$items.0.email" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({
			total: 1,
			email: sample.email,
		});
	});

	test("a missing result resolves to undefined, never throws", async () => {
		const Case = stepsCase({
			dependencies: { users: usersRepository() },
			response: blueprintOf((ctx) => ({ email: ctx.optional.string })),
			steps: [
				{ find: "users.findByEmail", args: ["$input.email"], as: "found" },
				{ return: { email: "$found.email" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({});
	});

	test("refuses write actions, unknown actions and unknown repositories", () => {
		const declare = (find: string) => () =>
			stepsCase({
				dependencies: { users: usersRepository() },
				steps: [{ find }, { return: {} }],
			});
		expect(invalidStep(declare("users.create")).code).toBe("write_in_find");
		expect(invalidStep(declare("users.findByName")).code).toBe(
			"unknown_action",
		);
		expect(invalidStep(declare("users.drop")).code).toBe("unknown_action");
		const walk = invalidStep(declare("users.forEachPage"));
		expect(walk.code).toBe("unknown_action");
		expect(walk.reason).toContain("cannot be a step");
		expect(invalidStep(declare("nope.findById")).code).toBe(
			"unknown_dependency",
		);
		expect(invalidStep(declare("usersfindById")).code).toBe("invalid_step");
		expect(invalidStep(declare("users.findById.x")).code).toBe("invalid_step");
	});

	test("a read action the repository was not declared with is unknown", () => {
		const Users = usersRepository();
		expect(
			invalidStep(() =>
				stepsCase({
					dependencies: { users: Users },
					steps: [{ find: "users.findManyByName" }, { return: {} }],
				}),
			).code,
		).toBe("unknown_action");
	});

	test("args must be a list of values or a reference", () => {
		const details = invalidStep(() =>
			stepsCase({
				dependencies: { users: usersRepository() },
				steps: [{ find: "users.findById", args: "id" }, { return: {} }],
			}),
		);
		expect(details).toMatchObject({ index: 0, code: "invalid_step" });
	});

	test("args as a reference must resolve to a list", async () => {
		const Case = stepsCase({
			dependencies: { users: usersRepository() },
			steps: [{ find: "users.findById", args: "$input.name" }, { return: {} }],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.name).toBe("InvalidUseCaseStep");
		expect(error.message).toContain("args must resolve to a list");
	});
});
