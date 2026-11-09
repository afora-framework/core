import { describe, expect, test } from "bun:test";
import { blueprintOf, inMemoryProvider, repositoryOf } from "../../../index";
import {
	invalidStep,
	sample,
	seedUser,
	stepsCase,
	User,
	UserResponse,
	usersRepository,
} from "./steps.fixtures";

describe("create, update and delete", () => {
	test("create stores the entity and binds the stored one", async () => {
		const Users = usersRepository();
		const Case = stepsCase({
			dependencies: { users: Users },
			response: UserResponse,
			steps: [
				{
					build: User,
					values: { name: "$input.name", email: "$input.email", password: "h" },
					as: "user",
				},
				{ create: "users", value: "$user", as: "saved" },
				{ return: { user: "$saved" } },
			],
		});
		const { user } = (await new Case(sample).execute()) as { user: User };
		expect((await Users.findById(user.id))?.email).toBe(sample.email);
	});

	test("update stores the changed entity", async () => {
		const Users = usersRepository();
		await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			response: UserResponse,
			steps: [
				{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
				{ change: "$user", key: "name", value: "Bia" },
				{ update: "users", value: "$user", as: "saved" },
				{ return: { user: "$saved" } },
			],
		});
		await new Case(sample).execute();
		expect((await Users.findByEmail(sample.email))?.name).toBe("Bia");
	});

	test("delete removes the entity", async () => {
		const Users = usersRepository();
		const saved = await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			response: blueprintOf((ctx) => ({ id: ctx.string })),
			steps: [
				{ delete: "users", value: saved.id, as: "gone" },
				{ return: { id: "$gone.id" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({ id: saved.id });
		expect(await Users.findById(saved.id)).toBeUndefined();
	});

	test("declaration rules", () => {
		const Users = usersRepository();
		const declare = (
			step: object,
			dependencies: Record<string, unknown> = { users: Users },
		) =>
			invalidStep(() =>
				stepsCase({ dependencies, steps: [step, { return: {} }] }),
			);
		expect(declare({ create: "nope", value: 1 }).code).toBe(
			"unknown_dependency",
		);
		expect(declare({ create: "users" }).code).toBe("invalid_step");
		expect(declare({ create: "users", value: 1, extra: 1 }).code).toBe(
			"invalid_step",
		);
		const Narrow = repositoryOf({
			entity: User,
			provider: inMemoryProvider(),
			actions: ["findById"],
		});
		expect(
			declare({ delete: "users", value: "x" }, { users: Narrow }).code,
		).toBe("unknown_action");
	});
});
