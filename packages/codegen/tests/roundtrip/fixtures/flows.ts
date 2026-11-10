import type { Spec } from "../../../src";

/** The hand-written use case: it extends the generated base. */
export const GREET_HANDLER = `import { GreetBase } from "../flows/use-cases";

export class Greet extends GreetBase {
	override async execute() {
		return { greeting: \`Hello, \${this.input.name}!\` };
	}
}
`;

/** The `imports` extraction needs to give back the pieces written by hand. */
export const FLOWS_IMPORTS = {
	"useCases.Register.run.hashPassword": "../support/hash#hashPassword",
	"useCases.Login.run.verify": "../support/hash#verify",
	"useCases.Greet": "../handlers/greet#Greet",
	"commands.Notifier.events": "../support/events#dispatch",
	"commands.Alerts.onEventError": "../support/events#onError",
};

/**
 * Use cases with every step kind (find, ensure, build, change, invoke, create,
 * update, delete, call, run, return), a hand-written use case, and commands
 * with context, a transaction and every event policy.
 */
export const flowsSpec: Spec = {
	version: 1,
	name: "flows",
	output: { dir: "src/flows" },
	provider: "inMemory",
	blueprints: {
		RegisterInput: {
			fields: { name: "text", email: "email", plainPassword: "string" },
		},
		Session: { fields: { requestId: "string" } },
	},
	entities: {
		User: {
			fields: { name: "text", email: "email", hash: "string" },
			unique: ["email"],
			change: ["name"],
			sensitive: ["hash"],
			plugins: ["taggable"],
		},
	},
	repositories: {
		Users: {
			entity: "User",
			actions: [
				"findById",
				"findByEmail",
				"findMany",
				"count",
				"create",
				"update",
				"delete",
			],
		},
	},
	exceptions: {
		UserAlreadyExists: {
			layer: "use-case",
			message: "A user with this email already exists.",
		},
		InvalidCredentials: { layer: "use-case" },
		Boom: { layer: "use-case", message: "Boom!" },
	},
	useCases: {
		Register: {
			description: "Signs a user up.",
			tags: ["users"],
			input: "RegisterInput",
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			errors: ["UserAlreadyExists", "RepositoryUniqueViolation"],
			implementation: {
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
						fn: { import: "../support/hash#hashPassword" },
						args: ["$input.plainPassword"],
						as: "hash",
					},
					{
						build: "User",
						values: {
							name: "$input.name",
							email: "$input.email",
							hash: "$hash",
						},
						as: "user",
					},
					{
						invoke: "$user",
						method: "tag",
						args: ["new", "member"],
						as: "tagged",
					},
					{ create: "users", value: "$tagged", as: "saved" },
					{ return: { user: "$saved" } },
				],
			},
		},
		RegisterAndFail: {
			input: "RegisterInput",
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			errors: ["Boom"],
			implementation: {
				steps: [
					{
						build: "User",
						values: {
							name: "$input.name",
							email: "$input.email",
							hash: "x",
						},
						as: "user",
					},
					{ create: "users", value: "$user", as: "saved" },
					{ ensure: "false", value: true, error: "Boom" },
					{ return: { user: "$saved" } },
				],
			},
		},
		Login: {
			input: { fields: { email: "email", plainPassword: "string" } },
			response: { fields: { user: "User", requestId: "string" } },
			context: "Session",
			dependencies: { users: "Users" },
			errors: ["InvalidCredentials"],
			deprecated: true,
			implementation: {
				steps: [
					{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
					{ ensure: "exists", value: "$user", error: "InvalidCredentials" },
					{
						ensure: "equals",
						value: "$user.email",
						other: "$input.email",
						error: "InvalidCredentials",
					},
					{
						ensure: "notEquals",
						value: "$user.email",
						other: "nobody@example.com",
						error: "InvalidCredentials",
					},
					{
						run: "verify",
						fn: { import: "../support/hash#verify" },
						args: ["$user", "$input.plainPassword"],
						as: "ok",
					},
					{ ensure: "true", value: "$ok", error: "InvalidCredentials" },
					{ return: { user: "$user", requestId: "$context.requestId" } },
				],
			},
		},
		Rename: {
			input: { fields: { email: "email", name: "text" } },
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			errors: ["InvalidCredentials"],
			implementation: {
				steps: [
					{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
					{ ensure: "exists", value: "$user", error: "InvalidCredentials" },
					{
						change: "$user",
						key: "name",
						value: "$input.name",
						as: "renamed",
					},
					{ update: "users", value: "$renamed", as: "saved" },
					{ return: { user: "$saved" } },
				],
			},
		},
		Remove: {
			input: { fields: { id: "id" } },
			response: { fields: { id: "id" } },
			dependencies: { users: "Users" },
			implementation: {
				steps: [
					{ delete: "users", value: "$input.id", as: "gone" },
					{ return: { id: "$gone.id" } },
				],
			},
		},
		SignUp: {
			input: "RegisterInput",
			response: { fields: { user: "User" } },
			dependencies: { register: "Register" },
			implementation: {
				steps: [
					{ call: "register", input: "$input", as: "done" },
					{ return: { user: "$done.user" } },
				],
			},
		},
		Greet: {
			input: { fields: { name: "text" } },
			response: { fields: { greeting: "string" } },
			implementation: { import: "../handlers/greet#Greet" },
		},
	},
	commands: {
		Accounts: {
			description: "Accounts.",
			tags: ["accounts"],
			context: "Session",
			useCases: {
				register: "Register",
				registerAndFail: "RegisterAndFail",
				login: "Login",
				rename: "Rename",
				remove: "Remove",
				signUp: "SignUp",
				greet: "Greet",
			},
			transaction: true,
		},
		Audit: {
			context: { fields: { actor: "text?" } },
			useCases: { register: "Register" },
			events: "manual",
		},
		Notifier: {
			useCases: { register: "Register" },
			events: { import: "../support/events#dispatch" },
		},
		Alerts: {
			useCases: { signUp: "Register" },
			onEventError: { import: "../support/events#onError" },
		},
	},
};
