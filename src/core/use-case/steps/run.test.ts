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

describe("run.params", () => {
	const Params = blueprintOf((ctx) => ({
		email: ctx.email,
		times: ctx.number,
	}));

	test("fn gets the args as the keys of params handled them", async () => {
		const seen: unknown[] = [];
		const Case = stepsCase({
			blueprint: blueprintOf((ctx) => ({ raw: ctx.string, n: ctx.number })),
			steps: [
				{
					run: "record",
					fn: (email: string, times: number) => {
						seen.push(email, times);
					},
					args: ["$input.raw", "$input.n"],
					params: Params,
				},
				{ return: {} },
			],
		});
		await new Case({ raw: "  ANA@Example.com ", n: 2 }).execute();
		expect(seen).toEqual(["ana@example.com", 2]);
	});

	test("an arg params rejects is an InvalidUseCaseStep with its issues, and fn does not run", async () => {
		let ran = false;
		const Case = stepsCase({
			blueprint: blueprintOf((ctx) => ({ raw: ctx.string })),
			steps: [
				{
					run: "record",
					fn: () => {
						ran = true;
					},
					args: ["$input.raw", "$input.raw"],
					params: Params,
				},
				{ return: {} },
			],
		});
		const error = await new Case({ raw: "nope" }).execute().catch((e) => e);
		expect(ran).toBe(false);
		expect(error.name).toBe("InvalidUseCaseStep");
		expect(error.details).toMatchObject({ index: 0, code: "invalid_args" });
		expect(error.message).toStartWith('Invalid step 0: the argument "email" ');
		expect(error.message).toEndWith("(and 1 more).");
		expect(
			error.details.issues.map((issue: { path: unknown }) => issue.path),
		).toEqual([["email"], ["times"]]);
	});

	test("a reference to a list of the wrong length fails while the steps run", async () => {
		const Case = stepsCase({
			blueprint: blueprintOf((ctx) => ({ tags: ctx.listOf(ctx.string) })),
			steps: [
				{ run: "record", fn: () => 1, args: "$input.tags", params: Params },
				{ return: {} },
			],
		});
		const error = await new Case({ tags: ["a"] }).execute().catch((e) => e);
		expect(error.details).toMatchObject({ code: "invalid_args" });
		expect(error.message).toContain("declares 2 parameter(s), args gave 1");
	});

	test("declaration rules", () => {
		const fn = () => 1;
		const declare = (step: object) =>
			invalidStep(() => stepsCase({ steps: [step, { return: {} }] }));
		expect(declare({ run: "a", fn, params: { email: "x" } }).code).toBe(
			"invalid_step",
		);
		expect(
			declare({ run: "a", fn, args: ["$input.email"], params: Params }),
		).toMatchObject({ index: 0, code: "invalid_args" });
		expect(declare({ run: "a", fn, params: Params }).code).toBe("invalid_args");
	});
});
