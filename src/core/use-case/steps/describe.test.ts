import { describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	inMemoryProvider,
	RepositoryUniqueViolation,
	recordOf,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../../index";
import {
	Empty,
	hashPassword,
	InvalidCredentials,
	loginOf,
	registerOf,
	User,
	UserAlreadyExists,
	usersRepository,
} from "./steps.fixtures";

function stepsOf(
	described: {
		useCases: Record<string, { implementation: object } | undefined>;
	},
	name: string,
) {
	return (described.useCases[name] as { implementation: { steps: object[] } })
		.implementation.steps;
}

function parts() {
	const Users = usersRepository();
	const Register = registerOf(Users);
	const Login = loginOf(Users);
	return {
		Users,
		Register,
		Login,
		settings: {
			name: "auth",
			entities: { User },
			repositories: { Users },
			exceptions: { UserAlreadyExists, InvalidCredentials },
			useCases: { Register, Login },
		},
	};
}

describe("describe() of steps use cases", () => {
	test("gives the steps with classes by name and fn as opaque", () => {
		const { settings } = parts();
		const described = applicationOf(settings as never).describe();
		expect(described.useCases.Register?.implementation).toEqual({
			kind: "steps",
			steps: [
				{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
				{
					ensure: "absent",
					value: "$existing",
					error: "UserAlreadyExists",
					details: { email: "$input.email" },
				},
				{
					run: "hashPassword",
					fn: { kind: "opaque" },
					args: ["$input.plainPassword"],
					as: "hash",
				},
				{
					build: "User",
					values: {
						name: "$input.name",
						email: "$input.email",
						password: "$hash",
					},
					as: "user",
				},
				{ create: "users", value: "$user", as: "saved" },
				{ return: { user: "$saved" } },
			],
		});
		expect(described.useCases.Login?.implementation).toMatchObject({
			kind: "steps",
		});
	});

	test("the descriptor is JSON and shares nothing with the declaration", () => {
		const { settings, Register } = parts();
		const described = applicationOf(settings as never).describe();
		const json = JSON.parse(JSON.stringify(described));
		expect(json.useCases.Register.implementation.steps).toHaveLength(6);
		const steps = stepsOf(described, "Register");
		(steps[0] as { args: string[] }).args.push("x");
		const again = applicationOf(settings as never).describe();
		expect(stepsOf(again, "Register")[0]).toMatchObject({
			args: ["$input.email"],
		});
		expect(Register).toBeDefined();
	});

	test("a core exception is described as { core }", () => {
		const Core = class extends useCaseOf({
			name: "Core",
			blueprint: Empty,
			response: Empty,
			errors: [RepositoryUniqueViolation],
			steps: [
				{
					ensure: "true",
					value: true,
					error: RepositoryUniqueViolation,
				},
				{ return: {} },
			],
		}) {};
		const described = applicationOf({
			name: "x",
			useCases: { Core },
		} as never).describe();
		expect(stepsOf(described, "Core")[0]).toMatchObject({
			error: { core: "RepositoryUniqueViolation" },
		});
	});

	test("a subclass that overrides execute is opaque", () => {
		const { settings, Register } = parts();
		class Custom extends Register {
			override async execute() {
				return {
					user: new User({ name: "a", email: "a@b.co", password: "x" }),
				};
			}
		}
		const described = applicationOf({
			...settings,
			useCases: { ...settings.useCases, Register: Custom },
		} as never).describe();
		expect(described.useCases.Register?.implementation).toEqual({
			kind: "opaque",
		});
		expect(described.useCases.Login?.implementation).toMatchObject({
			kind: "steps",
		});
	});

	test("a hand-written use case is opaque", () => {
		const Hand = class extends useCaseOf({
			name: "Hand",
			blueprint: Empty,
			response: Empty,
		}) {
			async execute() {
				return {};
			}
		};
		const described = applicationOf({
			name: "x",
			useCases: { Hand },
		} as never).describe();
		expect(described.useCases.Hand?.implementation).toEqual({
			kind: "opaque",
		});
	});

	test("a bound application still runs and describes the steps", async () => {
		const { settings } = parts();
		const app = applicationOf({
			...settings,
			provider: inMemoryProvider(),
		} as never) as never as {
			useCases: Record<
				string,
				new (
					input: unknown,
				) => { execute(): Promise<{ user: User }> }
			>;
			describe(): { useCases: Record<string, { implementation: object }> };
		};
		const Register = app.useCases.Register as NonNullable<
			(typeof app.useCases)[string]
		>;
		const { user } = await new Register({
			name: "Ana",
			email: "ana@example.com",
			plainPassword: "p",
		}).execute();
		expect(user.password).toBe(hashPassword("p"));
		expect(app.describe().useCases.Register?.implementation).toMatchObject({
			kind: "steps",
		});
	});
});

describe("registration of what the steps name", () => {
	test("a built class that is not registered is rejected", () => {
		const Note = recordOf(blueprintOf((ctx) => ({ text: ctx.string })));
		const Build = class extends useCaseOf({
			name: "Build",
			blueprint: Empty,
			response: Empty,
			steps: [
				{ build: Note, values: { text: "x" }, as: "note" },
				{ return: {} },
			],
		}) {};
		expect(() =>
			applicationOf({ name: "x", useCases: { Build } } as never),
		).toThrow(UnregisteredApplicationReference);
		expect(
			applicationOf({
				name: "x",
				records: { Note },
				useCases: { Build },
			} as never).describe().useCases.Build?.implementation,
		).toMatchObject({
			kind: "steps",
			steps: [{ build: "Note", as: "note" }, { return: {} }],
		});
	});

	test("an error that is not registered is rejected", () => {
		const { settings } = parts();
		expect(() =>
			applicationOf({
				...settings,
				exceptions: { UserAlreadyExists },
			} as never),
		).toThrow(UnregisteredApplicationReference);
	});
});
