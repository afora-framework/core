import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	CommandEventFailed,
	type CommandOperation,
	type CommandResponse,
	commandOf,
	type EntityEvent,
	type EventDefinition,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	InvalidCommandContext,
	InvalidCommandDeclaration,
	type IRepositoryProvider,
	inMemoryProvider,
	isCommand,
	repositoryOf,
	UnknownCommandOperation,
	useCaseOf,
} from "../../index";
import { isExportedException } from "../exception/exported";
import { Kind } from "../symbols/kind";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
const RequestContext = blueprintOf((ctx) => ({
	userId: ctx.id,
	requestId: ctx.string,
}));
const UserOnly = blueprintOf((ctx) => ({ userId: ctx.id }));
const userId = "0190a6a0-0000-7000-8000-000000000001";

const Boom = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Boom",
	message: "boom",
});

// The log of the handlers, shared by the events.
const handledEvents: string[] = [];
let failOn: string | undefined;
const handle = async (name: string) => {
	if (failOn === name) throw new Error(`failed ${name}`);
	handledEvents.push(name);
};

class Account extends entityOf(Name, { onCreate: () => Registered }) {
	rename(): void {
		this.emit(Renamed);
	}
}
// The annotations avoid a circular inference between the entity and its events.
const Registered: EventDefinition = eventOf("registered", Account, () =>
	handle("registered"),
);
const Renamed: EventDefinition = eventOf("renamed", Account, () =>
	handle("renamed"),
);

const world = (provider: IRepositoryProvider = inMemoryProvider()) => {
	const Accounts = repositoryOf({
		entity: Account,
		provider,
		actions: ["findById", "create", "count"],
	});
	const Response = blueprintOf(() => ({ account: Account }));
	const Count = blueprintOf((ctx) => ({ total: ctx.integer }));

	class Register extends useCaseOf({
		name: "Register",
		blueprint: Name,
		response: Response,
		dependencies: { accounts: Accounts },
	}) {
		override async execute({ accounts = this.dependencies.accounts } = {}) {
			return { account: await accounts.create(new Account(this.input)) };
		}
	}
	class RegisterAndFail extends useCaseOf({
		name: "RegisterAndFail",
		blueprint: Name,
		response: Response,
		dependencies: { accounts: Accounts },
	}) {
		override async execute({
			accounts = this.dependencies.accounts,
		} = {}): Promise<{ account: Account }> {
			await accounts.create(new Account(this.input));
			throw new Boom({ source: "RegisterAndFail" });
		}
	}
	class Total extends useCaseOf({
		name: "Total",
		blueprint: Empty,
		response: Count,
		dependencies: { accounts: Accounts },
	}) {
		override async execute({ accounts = this.dependencies.accounts } = {}) {
			return { total: await accounts.count() };
		}
	}
	class Rename extends useCaseOf({
		name: "Rename",
		blueprint: Name,
		response: Response,
		dependencies: { accounts: Accounts },
	}) {
		override async execute({ accounts = this.dependencies.accounts } = {}) {
			const account = await accounts.create(new Account(this.input));
			account.rename();
			return { account };
		}
	}
	return { Accounts, Register, RegisterAndFail, Total, Rename };
};

const loose = (command: unknown) =>
	command as {
		run(...args: unknown[]): Promise<unknown>;
		execute(...args: unknown[]): Promise<unknown>;
	};

const reset = () => {
	handledEvents.length = 0;
	failOn = undefined;
};

describe("declaration", () => {
	const { Register, Total } = world();

	test("freezes the command and exposes its settings", () => {
		const Users = commandOf({
			name: "Users",
			description: "Accounts.",
			tags: ["accounts"],
			useCases: { register: Register, total: Total },
		});
		expect(isCommand(Users)).toBe(true);
		expect(Users[Kind]).toBe("command");
		expect(Users.commandName).toBe("Users");
		expect(Users.description).toBe("Accounts.");
		expect(Users.tags).toEqual(["accounts"]);
		expect(Users.context).toBeUndefined();
		expect(Users.transaction).toBe(false);
		expect(Users.events).toBe("after-commit");
		expect(Users.operations).toEqual(["register", "total"]);
		expect(Users.useCases.register).toBe(Register);
		expect(Object.isFrozen(Users)).toBe(true);
		expect(Object.isFrozen(Users.useCases)).toBe(true);
		expect(Object.isFrozen(Users.tags)).toBe(true);
		expect(isCommand({})).toBe(false);
		expect(isCommand(null)).toBe(false);
	});

	test("defaults", () => {
		const Users = commandOf({ name: "Users", useCases: { total: Total } });
		expect(Users.description).toBeUndefined();
		expect(Users.tags).toEqual([]);
		expect(Users.onEventError).toBeUndefined();
	});

	const reason = (make: () => unknown) => {
		try {
			make();
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidCommandDeclaration);
			expect((error as { layer: string }).layer).toBe(ExceptionLayers.Command);
			return (error as { details: { reason: string } }).details.reason;
		}
		throw new Error("did not throw");
	};

	test("rejects every invalid setting with a reason", () => {
		const base = { name: "Users", useCases: { total: Total } };
		const bad = (extra: object) => () =>
			// biome-ignore lint/suspicious/noExplicitAny: invalid on purpose
			commandOf({ ...base, ...extra } as any);
		expect(reason(bad({ name: "" }))).toContain("name");
		expect(reason(bad({ name: 1 }))).toContain("name");
		expect(reason(bad({ description: 1 }))).toContain("description");
		expect(reason(bad({ tags: ["a", "a"] }))).toContain("tags");
		expect(reason(bad({ tags: [1] }))).toContain("tags");
		expect(reason(bad({ tags: "a" }))).toContain("tags");
		expect(reason(bad({ context: {} }))).toContain("context");
		expect(reason(bad({ context: UserOnly.optional }))).toContain("context");
		expect(reason(bad({ useCases: {} }))).toContain("useCases");
		expect(reason(bad({ useCases: undefined }))).toContain("useCases");
		expect(reason(bad({ useCases: { "not valid": Total } }))).toContain(
			"identifiers",
		);
		expect(reason(bad({ useCases: { total: {} } }))).toContain("use case");
		expect(reason(bad({ useCases: { total: new Total({}) } }))).toContain(
			"use case",
		);
		expect(reason(bad({ transaction: "yes" }))).toContain("transaction");
		expect(reason(bad({ events: "later" }))).toContain("events");
		expect(reason(bad({ onEventError: "x" }))).toContain("onEventError");
		expect(reason(bad({ events: "manual", onEventError: () => {} }))).toContain(
			"after-commit",
		);
		expect(reason(bad({ events: () => {}, onEventError: () => {} }))).toContain(
			"after-commit",
		);
	});

	test("accepts a handler and onEventError", () => {
		expect(
			commandOf({ name: "A", useCases: { total: Total }, events: () => {} })
				.events,
		).toBeFunction();
		const onEventError = () => {};
		expect(
			commandOf({ name: "A", useCases: { total: Total }, onEventError })
				.onEventError,
		).toBe(onEventError);
	});

	test("its exceptions are exported ones of the Command layer", () => {
		for (const Declared of [
			InvalidCommandDeclaration,
			UnknownCommandOperation,
			InvalidCommandContext,
			CommandEventFailed,
		]) {
			expect(Declared.layer).toBe(ExceptionLayers.Command);
			expect(isExportedException(Declared)).toBe(true);
		}
	});
});

describe("running", () => {
	test("runs every operation", async () => {
		reset();
		const { Register, Total } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { register: Register, total: Total },
		});
		const { account } = await Users.run("register", { name: "Ana" });
		expect(account.name).toBe("Ana");
		expect(await Users.run("total", {})).toEqual({ total: 1 });
		// A call builds its own use case.
		await Users.run("register", { name: "Bia" });
		expect(await Users.run("total", {})).toEqual({ total: 2 });
	});

	test("an unknown operation throws UnknownCommandOperation", async () => {
		const { Total } = world();
		const Users = commandOf({ name: "Users", useCases: { total: Total } });
		const unknown = loose(Users).run("missing", {});
		await expect(unknown).rejects.toBeInstanceOf(UnknownCommandOperation);
		await expect(unknown).rejects.toMatchObject({
			layer: ExceptionLayers.Command,
			details: { operation: "missing" },
		});
		await expect(loose(Users).execute("toString", {})).rejects.toBeInstanceOf(
			UnknownCommandOperation,
		);
	});

	test("input errors stay use case errors, with the command frame", async () => {
		const { Register } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { register: Register },
		});
		const error = await Users.run("register", { name: 1 } as never).catch(
			(caught) => caught,
		);
		expect(error.name).toBe("InvalidUseCaseInput");
		expect(error.passedThrough(ExceptionLayers.UseCase)).toBe(true);
		expect(error.source).toBe("Users.register");
	});

	test("the trace gets a command frame", async () => {
		const { RegisterAndFail } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { register: RegisterAndFail },
		});
		const error = await Users.run("register", { name: "Ana" }).catch(
			(caught) => caught,
		);
		expect(error.layer).toBe(ExceptionLayers.Command);
		expect(error.source).toBe("Users.register");
		expect(error.passedThrough(ExceptionLayers.UseCase)).toBe(true);
		expect(error.chain().map((step: { name: string }) => step.name)).toContain(
			"Boom",
		);
		expect(error.toString()).toContain("command @ Users.register");
	});

	test("concurrent runs are independent", async () => {
		reset();
		const { Register, Total } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { register: Register, total: Total },
		});
		const names = Array.from({ length: 20 }, (_, index) => `user${index}`);
		const results = await Promise.all(
			names.map((name) => Users.run("register", { name })),
		);
		expect(results.map((result) => result.account.name)).toEqual(names);
		expect(await Users.run("total", {})).toEqual({ total: 20 });
		expect(handledEvents).toHaveLength(20);
	});

	test("types", async () => {
		const { Register, Total } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { register: Register, total: Total },
		});
		expectTypeOf<CommandOperation<typeof Users>>().toEqualTypeOf<
			"register" | "total"
		>();
		expectTypeOf<CommandResponse<typeof Users, "total">>().toEqualTypeOf<{
			total: number;
		}>();
		const response = await Users.run("total", {});
		expectTypeOf(response.total).toBeNumber();
		const never = () => {
			// @ts-expect-error unknown operation
			void Users.run("missing", {});
			// @ts-expect-error the input of register has a name
			void Users.run("register", {});
		};
		void never;
	});
});

describe("context", () => {
	const make = () => {
		const seen: unknown[] = [];
		class Who extends useCaseOf({
			name: "Who",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({ userId: ctx.id })),
			context: UserOnly,
		}) {
			override async execute() {
				seen.push(this.context);
				return { userId: this.context.userId };
			}
		}
		class Anon extends useCaseOf({
			name: "Anon",
			blueprint: Empty,
			response: Empty,
		}) {
			override async execute() {
				seen.push(this.context);
				return {};
			}
		}
		class Full extends useCaseOf({
			name: "Full",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({ requestId: ctx.string })),
			context: RequestContext,
		}) {
			override async execute() {
				return { requestId: this.context.requestId };
			}
		}
		return { Who, Anon, Full, seen };
	};

	test("is validated once by the command and narrowed per use case", async () => {
		const { Who, Anon, seen } = make();
		const Users = commandOf({
			name: "Users",
			context: RequestContext,
			useCases: { who: Who, anon: Anon },
		});
		expect(Users.context).toBe(RequestContext);
		const context = { userId, requestId: "r1" } as never;
		expect(await Users.run("who", {}, { context })).toEqual({ userId });
		await Users.run("anon", {}, { context });
		// The use case gets only its own keys; one without a context gets none.
		expect(seen).toEqual([{ userId }, undefined]);
	});

	test("an invalid context throws InvalidCommandContext", async () => {
		const { Who } = make();
		const Users = commandOf({
			name: "Users",
			context: RequestContext,
			useCases: { who: Who },
		});
		const error = await Users.run(
			"who",
			{},
			{ context: { userId: "nope" } as never },
		).catch((caught) => caught);
		expect(error).toBeInstanceOf(InvalidCommandContext);
		expect(error.layer).toBe(ExceptionLayers.Command);
		expect(error.source).toBe("Users.who");
		expect(error.details.issues.length).toBeGreaterThan(0);
		const missing = Users.run("who", {}, undefined as never);
		await expect(missing).rejects.toBeInstanceOf(InvalidCommandContext);
	});

	test("a use case needing more than the command context fails on its own", async () => {
		const { Full } = make();
		const Users = commandOf({
			name: "Users",
			context: UserOnly,
			useCases: { full: Full },
		});
		await expect(
			Users.run("full", {}, { context: { userId } }),
		).rejects.toMatchObject({ name: "InvalidUseCaseContext" });
	});

	test("without a command context it goes to the use case as is", async () => {
		const { Who, Full } = make();
		const Users = commandOf({
			name: "Users",
			useCases: { who: Who, full: Full },
		});
		expect(await Users.run("who", {}, { context: { userId } })).toEqual({
			userId,
		});
		await expect(
			Users.run("who", {}, { context: { userId: "nope" } as never }),
		).rejects.toMatchObject({ name: "InvalidUseCaseContext" });
		// Typed by the use case: Full requires its context.
		// @ts-expect-error the context is required
		void Users.run("full", {}).catch(() => {});
	});
});

describe("transactions", () => {
	test("commits when the use case succeeds", async () => {
		reset();
		const { Register, Total, Accounts } = world();
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { register: Register, total: Total },
		});
		await Users.run("register", { name: "Ana" });
		expect(await Accounts.count()).toBe(1);
		expect(await Users.run("total", {})).toEqual({ total: 1 });
	});

	test("without transaction a failure keeps what was written", async () => {
		const { RegisterAndFail, Accounts } = world();
		const Users = commandOf({
			name: "Users",
			useCases: { fail: RegisterAndFail },
		});
		await expect(Users.run("fail", { name: "Ana" })).rejects.toBeDefined();
		expect(await Accounts.count()).toBe(1);
	});

	test("rolls back on a use case error and handles no events", async () => {
		reset();
		const { RegisterAndFail, Accounts } = world();
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { fail: RegisterAndFail },
		});
		const error = await Users.run("fail", { name: "Ana" }).catch(
			(caught) => caught,
		);
		expect(error.passedThrough(ExceptionLayers.UseCase)).toBe(true);
		expect(
			error.chain().some((step: { name: string }) => step.name === "Boom"),
		).toBe(true);
		expect(await Accounts.count()).toBe(0);
		expect(handledEvents).toEqual([]);
	});

	test("rolls back on an invalid response", async () => {
		const { Accounts } = world();
		class BadResponse extends useCaseOf({
			name: "BadResponse",
			blueprint: Name,
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { accounts: Accounts },
		}) {
			override async execute({ accounts = this.dependencies.accounts } = {}) {
				await accounts.create(new Account(this.input));
				return { total: "x" as unknown as number };
			}
		}
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { bad: BadResponse },
		});
		await expect(Users.run("bad", { name: "Ana" })).rejects.toMatchObject({
			name: "InvalidUseCaseResponse",
		});
		expect(await Accounts.count()).toBe(0);
	});

	test("child use cases and relations share the transaction", async () => {
		const { Accounts, RegisterAndFail } = world();
		class Parent extends useCaseOf({
			name: "Parent",
			blueprint: Name,
			response: Empty,
			dependencies: { child: RegisterAndFail },
		}) {
			override async execute({ child = this.dependencies.child } = {}) {
				await child(this.input);
				return {};
			}
		}
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { parent: Parent },
		});
		await expect(Users.run("parent", { name: "Ana" })).rejects.toBeDefined();
		expect(await Accounts.count()).toBe(0);
	});

	test("events are drained only after the transaction resolves", async () => {
		reset();
		const provider = inMemoryProvider();
		const { Register, Accounts } = world(provider);
		let seenInside = -1;
		const original = provider.transaction?.bind(provider);
		// biome-ignore lint/suspicious/noExplicitAny: spy on the provider
		(provider as any).transaction = async (run: any) => {
			const result = await original?.(run);
			seenInside = handledEvents.length;
			return result;
		};
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { register: Register },
		});
		await Users.run("register", { name: "Ana" });
		expect(seenInside).toBe(0);
		expect(handledEvents).toEqual(["registered"]);
		expect(await Accounts.count()).toBe(1);
	});

	test("a provider without transaction is rejected at declaration", () => {
		const { Register } = world({
			...inMemoryProvider(),
			transaction: undefined,
		});
		const declare = () =>
			commandOf({
				name: "Users",
				transaction: true,
				useCases: { register: Register },
			});
		expect(declare).toThrow(InvalidCommandDeclaration);
		try {
			declare();
		} catch (error) {
			expect((error as Error).message).toContain("Account");
			expect((error as Error).message).toContain("transactions");
		}
		// Fine without a transaction.
		expect(
			commandOf({ name: "Users", useCases: { register: Register } }),
		).toBeDefined();
	});

	test("repositories on different providers are rejected at declaration", () => {
		const { Register } = world();
		class Other extends entityOf(Name) {}
		const Others = repositoryOf({
			entity: Other,
			provider: inMemoryProvider(),
			actions: ["create"],
		});
		class Make extends useCaseOf({
			name: "Make",
			blueprint: Name,
			response: Empty,
			dependencies: { others: Others },
		}) {
			override async execute({ others = this.dependencies.others } = {}) {
				await others.create(new Other(this.input));
				return {};
			}
		}
		class Both extends useCaseOf({
			name: "Both",
			blueprint: Name,
			response: Empty,
			dependencies: { make: Make },
		}) {
			override async execute({ make = this.dependencies.make } = {}) {
				await make(this.input);
				return {};
			}
		}
		const declare = () =>
			commandOf({
				name: "Users",
				transaction: true,
				useCases: { register: Register, both: Both },
			});
		expect(declare).toThrow(InvalidCommandDeclaration);
		try {
			declare();
		} catch (error) {
			expect((error as Error).message).toContain("Account");
			expect((error as Error).message).toContain("Other");
		}
	});

	test("two use cases on the same provider are accepted", () => {
		const { Register, Total } = world();
		expect(
			commandOf({
				name: "Users",
				transaction: true,
				useCases: { register: Register, total: Total },
			}).transaction,
		).toBe(true);
	});
});

describe("event policies", () => {
	const events = (count: number) =>
		Array.from({ length: count }, (_, index) => `e${index}`);

	/** A command whose use case raises the events of `names`, in order. */
	const raising = (
		names: readonly string[],
		settings: Record<string, unknown> = {},
	) => {
		class Thing extends entityOf(Name) {
			raise(): void {
				for (const name of names)
					this.emit(definitions[name] as EventDefinition);
			}
		}
		const definitions: Record<string, EventDefinition> = {};
		for (const name of names) {
			definitions[name] = eventOf(name, Thing, () => handle(name));
		}
		class Raise extends useCaseOf({
			name: "Raise",
			blueprint: Empty,
			response: Empty,
			dependencies: {
				things: repositoryOf({ entity: Thing, actions: ["create"] }),
			},
		}) {
			override async execute({ things = this.dependencies.things } = {}) {
				const thing = new Thing({ name: "x" });
				thing.raise();
				await things.create(thing);
				return {};
			}
		}
		return commandOf({
			name: "Events",
			useCases: { raise: Raise },
			...settings,
		} as never) as unknown as ReturnType<
			typeof commandOf<{ raise: typeof Raise }>
		>;
	};

	test("after-commit handles the events in emission order", async () => {
		reset();
		const Command = raising(events(3));
		await Command.run("raise", {});
		expect(handledEvents).toEqual(["e0", "e1", "e2"]);
	});

	test("after-commit throws CommandEventFailed on the first failure", async () => {
		reset();
		failOn = "e1";
		const Command = raising(events(4));
		const error = await Command.run("raise", {}).catch((caught) => caught);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect(error.layer).toBe(ExceptionLayers.Command);
		expect(error.cause.message).toBe("failed e1");
		expect(error.details).toEqual({
			operation: "raise",
			event: "e1",
			handled: 1,
			remaining: 2,
		});
		expect(handledEvents).toEqual(["e0"]);
	});

	test("onEventError is awaited and the next events still run", async () => {
		reset();
		failOn = "e1";
		const reported: [string, string][] = [];
		const Command = raising(events(3), {
			onEventError: async (error: unknown, event: EntityEvent) => {
				await Promise.resolve();
				reported.push([(error as Error).message, event.name]);
			},
		});
		await Command.run("raise", {});
		expect(reported).toEqual([["failed e1", "e1"]]);
		expect(handledEvents).toEqual(["e0", "e2"]);
	});

	test("a failing onEventError is a CommandEventFailed", async () => {
		reset();
		failOn = "e0";
		const Command = raising(events(2), {
			onEventError: () => {
				throw new Error("report failed");
			},
		});
		const error = await Command.run("raise", {}).catch((caught) => caught);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect(error.cause.message).toBe("report failed");
		expect(error.details.event).toBe("e0");
	});

	test("manual drops the events in run", async () => {
		reset();
		const Command = raising(events(2), { events: "manual" });
		await Command.run("raise", {});
		expect(handledEvents).toEqual([]);
	});

	test("a handler receives all the events and the call", async () => {
		reset();
		const calls: unknown[] = [];
		const Command = raising(events(2), {
			events: async (
				raised: readonly EntityEvent[],
				info: { command: unknown; operation: string; context: unknown },
			) => {
				calls.push([raised.map((event) => event.name), info.operation]);
				calls.push(info.command);
				calls.push(info.context);
			},
		});
		await Command.run("raise", {});
		expect(handledEvents).toEqual([]);
		expect(calls).toEqual([[["e0", "e1"], "raise"], Command, undefined]);
	});

	test("a handler gets the validated context", async () => {
		const { Who } = (() => {
			class Who extends useCaseOf({
				name: "Who",
				blueprint: Empty,
				response: Empty,
				context: UserOnly,
			}) {
				override async execute() {
					return {};
				}
			}
			return { Who };
		})();
		let received: unknown;
		const Users = commandOf({
			name: "Users",
			context: RequestContext,
			useCases: { who: Who },
			events: (_events, info) => {
				received = info.context;
			},
		});
		await Users.run(
			"who",
			{},
			{ context: { userId, requestId: "r" } as never },
		);
		expect(received).toEqual({ userId, requestId: "r" });
	});

	test("a rejecting handler is a CommandEventFailed", async () => {
		const Command = raising(events(1), {
			events: async () => {
				throw new Error("handler failed");
			},
		});
		const error = await Command.run("raise", {}).catch((caught) => caught);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect(error.cause.message).toBe("handler failed");
		expect(error.details).toEqual({
			operation: "raise",
			handled: 0,
			remaining: 1,
		});
	});

	test("a call with no events handles none", async () => {
		reset();
		const Command = raising([]);
		await Command.run("raise", {});
		expect(handledEvents).toEqual([]);
	});
});

describe("execute", () => {
	test("gives the response and the events, without applying the policy", async () => {
		reset();
		const { Rename } = world();
		const Users = commandOf({ name: "Users", useCases: { rename: Rename } });
		const { value, events } = await Users.execute("rename", { name: "Ana" });
		expect(value.account.name).toBe("Ana");
		expect(events.map((event) => event.name)).toEqual([
			"registered",
			"renamed",
		]);
		expect(handledEvents).toEqual([]);
		await events[0]?.handle();
		expect(handledEvents).toEqual(["registered"]);
	});

	test("also validates operation, context and runs the transaction", async () => {
		reset();
		const { RegisterAndFail, Accounts } = world();
		const Users = commandOf({
			name: "Users",
			transaction: true,
			useCases: { fail: RegisterAndFail },
		});
		await expect(Users.execute("fail", { name: "Ana" })).rejects.toBeDefined();
		expect(await Accounts.count()).toBe(0);
		await expect(loose(Users).execute("x", {})).rejects.toBeInstanceOf(
			UnknownCommandOperation,
		);
	});
});
