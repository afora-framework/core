import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../../index";
import {
	invalidStep,
	sample,
	seedUser,
	stepsCase,
	usersRepository,
} from "./steps.fixtures";

describe("run", () => {
	test("awaits fn with the resolved args, then the context and dependencies", async () => {
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
		expect(seen).toEqual([
			["Ana", { n: 1 }, { context: { tenant: "acme" }, dependencies: {} }],
		]);
	});

	test("fn gets the dependencies of the call, overrides included", async () => {
		const Users = usersRepository();
		await seedUser(Users);
		const Case = stepsCase({
			dependencies: { users: Users },
			response: blueprintOf((ctx) => ({ taken: ctx.boolean })),
			steps: [
				{
					run: "check",
					fn: async (
						email: string,
						{ dependencies }: { dependencies: { users: typeof Users } },
					) => (await dependencies.users.findByEmail(email)) !== undefined,
					args: ["$input.email"],
					as: "taken",
				},
				{ return: { taken: "$taken" } },
			],
		});
		expect(await new Case(sample).execute()).toEqual({ taken: true });
		expect(
			await new Case(sample).execute({
				users: { findByEmail: async () => undefined },
			}),
		).toEqual({ taken: false });
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
