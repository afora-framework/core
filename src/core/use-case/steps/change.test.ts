import { describe, expect, test } from "bun:test";
import {
	invalidStep,
	sample,
	seedUser,
	stepsCase,
	User,
	UserResponse,
	usersRepository,
} from "./steps.fixtures";

const build = {
	build: User,
	values: { name: "$input.name", email: "$input.email", password: "h" },
	as: "user",
};

describe("change", () => {
	test("calls the change method of the key and binds the record", async () => {
		const Case = stepsCase({
			response: UserResponse,
			steps: [
				build,
				{ change: "$user", key: "name", value: "Bia", as: "renamed" },
				{ return: { user: "$renamed" } },
			],
		});
		const { user } = (await new Case(sample).execute()) as { user: User };
		expect(user.name).toBe("Bia");
	});

	test("a key that the built class does not change is rejected at declaration", () => {
		const details = invalidStep(() =>
			stepsCase({
				steps: [
					build,
					{ change: "$user", key: "email", value: "x@example.com" },
					{ return: {} },
				],
			}),
		);
		expect(details).toMatchObject({ index: 1, code: "invalid_change_key" });
	});

	test("a class that is not statically known is checked at execution", async () => {
		const Users = usersRepository();
		await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			steps: [
				{ find: "users.findByEmail", args: ["$input.email"], as: "found" },
				{ change: "$found", key: "email", value: "x@example.com" },
				{ return: {} },
			],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.name).toBe("InvalidUseCaseStep");
		expect(error.message).toContain("Invalid step 1");
	});

	test("a target that is not a record throws InvalidUseCaseStep with the index", async () => {
		const Case = stepsCase({
			steps: [
				{ change: "$input.name", key: "name", value: "x" },
				{ return: {} },
			],
		});
		const error = await new Case(sample).execute().catch((e) => e);
		expect(error.name).toBe("InvalidUseCaseStep");
		expect(error.layer).toBe("use-case");
	});

	test("the target must be a reference", () => {
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [
						build,
						{ change: "user", key: "name", value: "x" },
						{ return: {} },
					],
				}),
			).code,
		).toBe("invalid_reference");
	});
});
