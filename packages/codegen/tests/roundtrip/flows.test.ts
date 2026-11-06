import { afterAll, describe, expect, test } from "bun:test";
import { extractSpec, validateSpec } from "../../src";
import { FLOWS_IMPORTS, flowsSpec, GREET_HANDLER } from "./fixtures/flows";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

const caught = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string }) => error.name,
	);

/** Runs the commands: transaction and rollback, every step kind, the hand-written use case. */
async function behave(App: Any) {
	const { Accounts, Audit, Notifier, Alerts } = App.commands;
	const input = { name: "Ana", email: "ana@example.com", plainPassword: "pw" };
	const session = (requestId: string) => ({ context: { requestId } });

	const registered = await Accounts.run("register", input, session("r1"));
	const duplicate = await Accounts.run("register", input, session("r2")).catch(
		(error: Error) => error,
	);
	const login = await Accounts.run(
		"login",
		{ email: input.email, plainPassword: "pw" },
		session("r3"),
	);
	const wrong = await caught(
		Accounts.run(
			"login",
			{ email: input.email, plainPassword: "nope" },
			session("r4"),
		),
	);
	const renamed = await Accounts.run(
		"rename",
		{ email: input.email, name: "Ana Maria" },
		session("r5"),
	);
	const signedUp = await Accounts.run(
		"signUp",
		{ name: "Bia", email: "bia@example.com", plainPassword: "pw" },
		session("r6"),
	);
	const failure = await caught(
		Accounts.run(
			"registerAndFail",
			{ name: "Caio", email: "caio@example.com", plainPassword: "pw" },
			session("r7"),
		),
	);
	const greeting = await Accounts.run("greet", { name: "Dani" }, session("r8"));
	await Audit.run(
		"register",
		{ ...input, email: "audit@example.com" },
		{
			context: {},
		},
	);
	await Notifier.run("register", { ...input, email: "notify@example.com" });
	await Alerts.run("signUp", { ...input, email: "alert@example.com" });
	const removed = await Accounts.run(
		"remove",
		{ id: signedUp.user.id },
		session("r9"),
	);

	const users = App.repositories.Users;
	return {
		registered: {
			name: registered.user.name,
			tags: registered.user.tags,
			hash: registered.user.toJSON().hash,
		},
		duplicate: {
			name: (duplicate as Error).name,
			message: (duplicate as Error).message,
		},
		login: { email: login.user.email, requestId: login.requestId },
		wrong,
		renamed: renamed.user.name,
		signedUp: signedUp.user.email,
		failure,
		rolledBack: (await users.findByEmail("caio@example.com")) === undefined,
		greeting: greeting.greeting,
		removed: removed.id === signedUp.user.id,
		remaining: await users.count(),
	};
}

const EXPECTED = {
	registered: { name: "Ana", tags: ["new", "member"], hash: "********" },
	duplicate: {
		name: "UserAlreadyExists",
		message: "A user with this email already exists.",
	},
	login: { email: "ana@example.com", requestId: "r3" },
	wrong: "InvalidCredentials",
	renamed: "Ana Maria",
	signedUp: "bia@example.com",
	failure: "Boom",
	rolledBack: true,
	greeting: "Hello, Dani!",
	removed: true,
	remaining: 4,
};

describe("JSON -> app -> JSON: flows", () => {
	test("the spec is valid", () => {
		expect(validateSpec(flowsSpec)).toEqual([]);
	});

	test("generates clean code, behaves and extracts to the same spec", async () => {
		const project = await buildProject(
			[{ root: ".", spec: flowsSpec }],
			{},
			{
				"src/handlers/greet.ts": GREET_HANDLER,
			},
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await behave(App)).toEqual(EXPECTED);

		const extracted = extractSpec(App, {
			outputDir: "src/flows",
			imports: FLOWS_IMPORTS,
		});
		expect(validateSpec(extracted)).toEqual([]);
		expect(canonical(extracted)).toEqual(canonical(flowsSpec));
	}, 180_000);
});
