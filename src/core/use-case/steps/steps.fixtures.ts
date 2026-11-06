import {
	blueprintOf,
	type EventDefinition,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	inMemoryProvider,
	repositoryOf,
	useCaseOf,
} from "../../../index";

/** Shared declarations of the tests of the steps DSL: a user who registers and logs in. */
export const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: ({ email }: { email: string }) => `${email} is taken.`,
});
export const InvalidCredentials = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidCredentials",
	message: "Invalid credentials.",
});

export const hashPassword = (plain: unknown) => `hash:${String(plain)}`;

const RegisterInput = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	plainPassword: ctx.string,
}));
const LoginInput = blueprintOf((ctx) => ({
	email: ctx.email,
	plainPassword: ctx.string,
}));
export const Empty = blueprintOf(() => ({}));

export class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		email: ctx.email,
		password: ctx.string,
	})),
	{
		unique: ["email"],
		change: ["name"],
		sensitive: ["password"],
		onCreate: () => UserCreated,
	},
) {
	matches(plain: string): boolean {
		return this.password === hashPassword(plain);
	}
	greet(greeting: string): string {
		return `${greeting}, ${this.name}`;
	}
}
// The annotation avoids a circular inference between the entity and its event.
const UserCreated: EventDefinition = eventOf(
	"user.created",
	User,
	async () => {},
);

export const UserResponse = blueprintOf(() => ({ user: User }));

/** A repository of users with every action, on a fresh in-memory provider. */
export function usersRepository() {
	return repositoryOf({
		entity: User,
		provider: inMemoryProvider(),
		actions: [
			"findById",
			"findByEmail",
			"findMany",
			"count",
			"exists",
			"create",
			"update",
			"delete",
		],
	});
}

/** The Register use case of the design, over `Users`. */
export function registerOf(Users: ReturnType<typeof usersRepository>) {
	return class Register extends useCaseOf({
		name: "Register",
		blueprint: RegisterInput,
		response: UserResponse,
		dependencies: { users: Users },
		errors: [UserAlreadyExists],
		steps: [
			{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
			{
				ensure: "absent",
				value: "$existing",
				error: UserAlreadyExists,
				details: { email: "$input.email" },
			},
			{
				run: "hashPassword",
				fn: hashPassword,
				args: ["$input.plainPassword"],
				as: "hash",
			},
			{
				build: User,
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
	}) {};
}

/** The Login use case over `Users`. */
export function loginOf(Users: ReturnType<typeof usersRepository>) {
	return class Login extends useCaseOf({
		name: "Login",
		blueprint: LoginInput,
		response: UserResponse,
		dependencies: { users: Users },
		errors: [InvalidCredentials],
		steps: [
			{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
			{ ensure: "exists", value: "$user", error: InvalidCredentials },
			{
				invoke: "$user",
				method: "matches",
				args: ["$input.plainPassword"],
				as: "ok",
			},
			{ ensure: "true", value: "$ok", error: InvalidCredentials },
			{ return: { user: "$user" } },
		],
	}) {};
}

/** A use case class built from `steps` and loosely typed settings, for tests that try many shapes. */
export function stepsCase(config: {
	readonly steps: readonly unknown[];
	readonly dependencies?: Record<string, unknown>;
	readonly errors?: readonly unknown[];
	readonly blueprint?: unknown;
	readonly response?: unknown;
	readonly context?: unknown;
}) {
	return useCaseOf({
		name: "Case",
		blueprint: RegisterInput,
		response: Empty,
		...config,
	} as never) as unknown as new (
		input: unknown,
		options?: unknown,
	) => {
		execute(overrides?: unknown): Promise<Record<string, unknown>>;
		pullEvents(): { name: string }[];
	};
}

/** The `details` of the `InvalidUseCaseStep` that `declare` throws. */
export function invalidStep(declare: () => unknown) {
	try {
		declare();
	} catch (error) {
		const thrown = error as {
			name: string;
			details: { index: number; reason: string; code: string };
		};
		if (thrown.name === "InvalidUseCaseStep") return thrown.details;
		throw error;
	}
	throw new Error("Expected an InvalidUseCaseStep.");
}

export const sample = {
	name: "Ana",
	email: "ana@example.com",
	plainPassword: "p",
};

/** Stores a user for `sample` in `Users`. */
export function seedUser(Users: ReturnType<typeof usersRepository>) {
	return Users.create(
		new User({ name: "Ana", email: sample.email, password: "h" }),
	);
}
