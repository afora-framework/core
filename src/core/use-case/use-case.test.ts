import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	type EventDefinition,
	Exception,
	ExceptionLayers,
	entityOf,
	environmentOf,
	eventOf,
	InvalidUseCaseDeclaration,
	isUseCase,
	isUseCaseClass,
	RepositoryOf,
	RepositoryUniqueViolation,
	recordOf,
	repositoryOf,
	UseCaseAlreadyExecuted,
	type UseCaseDependencies,
	type UseCaseInput,
	type UseCaseResponse,
	useCaseOf,
} from "../../index";
import { variantOf } from "../blueprint/variant";
import { AbstractUseCase } from "./use-case";

const Input = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
let handled = 0;
class User extends entityOf(Input) {
	publish(): void {
		this.emit(Created);
	}
}
const Created = eventOf("created", User, async () => {
	handled++;
});
const Output = blueprintOf(() => ({ user: User }));
const LeafBase = useCaseOf({
	name: "CreateUser",
	blueprint: Input,
	response: Output,
});
class Leaf extends LeafBase {
	override async execute() {
		const user = new User(this.input);
		user.publish();
		return { user };
	}
}
const ParentBase = useCaseOf({
	name: "Parent",
	blueprint: Input,
	response: Empty,
	dependencies: { create: Leaf, other: Leaf },
});
class Parent extends ParentBase {
	override async execute({
		create = this.dependencies.create,
		other = this.dependencies.other,
	} = {}) {
		await create(this.input);
		await other(this.input);
		return {};
	}
}

describe("use cases", () => {
	test("validates input, exposes read-only input and class metadata", async () => {
		const op = new Leaf({ name: "Ana" });
		expect(op).toBeInstanceOf(AbstractUseCase);
		expect(isUseCase(op)).toBe(true);
		expect(isUseCaseClass(Leaf)).toBe(true);
		expect(isUseCaseClass(LeafBase)).toBe(false);
		expect(isUseCaseClass(User)).toBe(false);
		expect(Leaf.useCaseName).toBe("CreateUser");
		expect(Object.isFrozen(op.input)).toBe(true);
		expect(() => Object.assign(op, { input: {} })).toThrow();
		expect(() => new Leaf({ name: 4 } as never)).toThrow(
			"Invalid UseCase input",
		);
		const result = await op.execute();
		expect(result.user).toBeInstanceOf(User);
		expect(result.user.name).toBe("Ana");
	});

	test("resolves fresh transitive children and drains events without handling", async () => {
		const GrandBase = useCaseOf({
			name: "Grand",
			blueprint: Input,
			response: Empty,
			dependencies: { parent: Parent },
		});
		class Grand extends GrandBase {
			override async execute(deps = this.dependencies) {
				await deps.parent(this.input);
				return {};
			}
		}
		const op = new Grand({ name: "Ana" });
		const before = handled;
		await op.execute();
		const events = op.pullEvents();
		expect(events.map((event) => event.name)).toEqual(["created", "created"]);
		expect(events[0]?.entity).not.toBe(events[1]?.entity);
		expect(op.pullEvents()).toEqual([]);
		expect(handled).toBe(before);
		await events[0]?.handle();
		expect(handled).toBe(before + 1);
	});

	test("accepts partial substitutes, validates them and collects their response events", async () => {
		const user = new User({ name: "Override" });
		user.publish();
		const op = new Parent({ name: "Ana" });
		await op.execute({
			create: async (input) => {
				expect(input.name).toBe("Ana");
				return { user };
			},
		});
		const events = op.pullEvents();
		expect(events).toHaveLength(2);
		expect(events[0]?.entity).toBe(user);
		await expect(
			new Parent({ name: "Ana" }).execute({
				create: async () => ({ user: 1 }),
			} as never),
		).rejects.toThrow("Invalid UseCase response");
		await expect(
			new Parent({ name: "Ana" }).execute({
				absent: async () => ({}),
			} as never),
		).rejects.toMatchObject({ name: "InvalidUseCaseDependencies" });
	});

	test("rejects concurrent, repeated and post-failure execution", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class Slow extends LeafBase {
			override async execute() {
				await gate;
				return { user: new User(this.input) };
			}
		}
		const op = new Slow({ name: "Ana" });
		const running = op.execute();
		await expect(op.execute()).rejects.toBeInstanceOf(UseCaseAlreadyExecuted);
		release();
		await running;
		await expect(op.execute()).rejects.toBeInstanceOf(UseCaseAlreadyExecuted);
		class Fails extends LeafBase {
			override async execute(): Promise<never> {
				throw new Error("failed");
			}
		}
		const failed = new Fails({ name: "Ana" });
		await expect(failed.execute()).rejects.toThrow("failed");
		await expect(failed.execute()).rejects.toBeInstanceOf(
			UseCaseAlreadyExecuted,
		);
	});

	test("collects nested records and lists once per object, preserving duplicate occurrences", async () => {
		class Box extends recordOf(Output) {}
		const Nested = blueprintOf((ctx) => ({
			box: Box,
			users: ctx.listOf(User),
			optional: ctx.optionalOf(User),
		}));
		const user = new User({ name: "Ana" });
		user.publish();
		user.publish();
		class NestedCase extends useCaseOf({
			name: "Nested",
			blueprint: Empty,
			response: Nested,
		}) {
			override async execute() {
				return { box: new Box({ user }), users: [user, user] };
			}
		}
		const op = new NestedCase({});
		await op.execute();
		expect(op.pullEvents()).toHaveLength(2);
		expect(user.pullEvents()).toEqual([]);
	});

	test("does not drain entities from invalid responses", async () => {
		const user = new User({ name: "Ana" });
		user.publish();
		class Invalid extends LeafBase {
			override async execute() {
				return { user, extra: true };
			}
		}
		const op = new Invalid({ name: "Ana" });
		await expect(op.execute()).rejects.toThrow("Invalid UseCase response");
		expect(op.pullEvents()).toEqual([]);
		expect(user.pullEvents()).toHaveLength(1);
	});

	test("keeps child events after a parent fails, including transitively", async () => {
		const failure = new Exception({
			name: "Failure",
			message: "failed",
			layer: ExceptionLayers.Entity,
			source: "User",
		});
		class Fails extends ParentBase {
			override async execute(deps = this.dependencies): Promise<never> {
				await deps.create(this.input);
				throw failure;
			}
		}
		class Grand extends useCaseOf({
			name: "Grand",
			blueprint: Input,
			response: Empty,
			dependencies: { fail: Fails },
		}) {
			override async execute(deps = this.dependencies) {
				await deps.fail(this.input);
				return {};
			}
		}
		const op = new Grand({ name: "Ana" });
		try {
			await op.execute();
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(Exception);
			expect((error as Exception).trace.map((frame) => frame.source)).toEqual([
				"User",
				"Parent",
				"Grand",
			]);
		}
		expect(op.pullEvents()).toHaveLength(1);
	});

	test("rejects malformed declarations and dependencies", () => {
		expect(() =>
			useCaseOf({
				name: "Bad",
				blueprint: Empty,
				response: Empty,
				dependencies: { user: User },
			} as never),
		).toThrow(InvalidUseCaseDeclaration);
		expect(() =>
			useCaseOf({ name: "", blueprint: Empty, response: Empty }),
		).toThrow(InvalidUseCaseDeclaration);
	});

	test("infers constructor, response and dependency types", () => {
		expectTypeOf<UseCaseInput<typeof Leaf>>().toEqualTypeOf<{ name: string }>();
		expectTypeOf<UseCaseResponse<typeof Leaf>>().toEqualTypeOf<{
			user: User;
		}>();
		expectTypeOf<UseCaseDependencies<typeof Parent>["create"]>().toEqualTypeOf<
			(input: { name: string }) => Promise<{ user: User }>
		>();
	});
});

// Compile-time contracts; never invoked.
export function typeContracts() {
	// @ts-expect-error execute is abstract
	class _Missing extends LeafBase {}
	class _Wrong extends LeafBase {
		// @ts-expect-error response must match the declared blueprint
		override async execute() {
			return { wrong: true };
		}
	}
	class _Synchronous extends LeafBase {
		// @ts-expect-error execute must be asynchronous
		override execute() {
			return { user: new User({ name: "Ana" }) };
		}
	}
	// @ts-expect-error input must match the blueprint
	new Leaf({ name: 1 });
	useCaseOf({
		name: "Bad",
		blueprint: Empty,
		response: Empty,
		// @ts-expect-error dependencies accept only concrete UseCase classes
		dependencies: { user: User },
	});
	useCaseOf({
		name: "Bad",
		blueprint: Empty,
		response: Empty,
		// @ts-expect-error abstract UseCases cannot be dependency implementations
		dependencies: { leaf: LeafBase },
	});
	const op = new Parent({ name: "Ana" });
	op.execute({ create: async () => ({ user: new User({ name: "Ana" }) }) });
	// @ts-expect-error undeclared dependency
	op.execute({ missing: async () => ({}) });
}

test("validates child input before calling substitutes and retains issue paths", async () => {
	let calls = 0;
	class InvalidCall extends ParentBase {
		override async execute({ create = this.dependencies.create } = {}) {
			await create({ name: 42 } as never);
			return {};
		}
	}
	try {
		await new InvalidCall({ name: "Ana" }).execute({
			create: async () => {
				calls++;
				return { user: new User({ name: "Stub" }) };
			},
		});
		throw new Error("expected rejection");
	} catch (error) {
		const exception = error as Exception;
		expect(exception.name).toBe("InvalidUseCaseInput");
		expect(exception.trace.at(-1)?.source).toBe("Parent");
		const childFrame = exception.trace.find(
			(frame) => frame.source === "CreateUser",
		);
		expect(childFrame?.details).toMatchObject({ issues: [{ path: ["name"] }] });
	}
	expect(calls).toBe(0);
});

test("returned child entities are not double-drained; new parent events follow child events", async () => {
	class PassThrough extends useCaseOf({
		name: "PassThrough",
		blueprint: Input,
		response: Output,
		dependencies: { create: Leaf },
	}) {
		override async execute({ create = this.dependencies.create } = {}) {
			const result = await create(this.input);
			result.user.publish();
			return result;
		}
	}
	class Inherited extends PassThrough {}
	const op = new Inherited({ name: "Ana" });
	const result = await op.execute();
	const events = op.pullEvents();
	expect(events).toHaveLength(2);
	expect(events.every((event) => event.entity === result.user)).toBe(true);
});

test("parallel children contribute in completion order", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	class Parallel extends ParentBase {
		override async execute({
			create = this.dependencies.create,
			other = this.dependencies.other,
		} = {}) {
			const first = create({ name: "slow" });
			await other({ name: "fast" });
			release();
			await first;
			return {};
		}
	}
	const op = new Parallel({ name: "Ana" });
	await op.execute({
		create: async (input) => {
			await gate;
			const user = new User(input);
			user.publish();
			return { user };
		},
	});
	expect(op.pullEvents().map((event) => (event.entity as User).name)).toEqual([
		"fast",
		"slow",
	]);
});

test("dependency getter respects overrides and functions cannot run outside execution", async () => {
	class Getter extends ParentBase {
		override async execute() {
			await this.dependencies.create(this.input);
			return {};
		}
	}
	const op = new Getter({ name: "Ana" });
	await expect(
		op.dependencies.create({ name: "before" }),
	).rejects.toMatchObject({ name: "InvalidUseCaseDependencies" });
	let called = false;
	// The base interface accepts overrides even when an implementation ignores its argument.
	await (op as InstanceType<typeof ParentBase>).execute({
		create: async (input) => {
			called = true;
			return { user: new User(input) };
		},
	});
	expect(called).toBe(true);
	await expect(op.dependencies.create({ name: "after" })).rejects.toMatchObject(
		{ name: "InvalidUseCaseDependencies" },
	);
});

describe("repositories and environments as dependencies", () => {
	const Users = repositoryOf({
		entity: User,
		actions: ["findById", "create", "count"],
	});
	const Settings = environmentOf(
		blueprintOf((ctx) => ({ GREETING: ctx.string })),
		{ source: () => ({ GREETING: "Olá" }) },
	);
	const RegisterBase = useCaseOf({
		name: "Register",
		blueprint: Input,
		response: blueprintOf((ctx) => ({ id: ctx.string, greeting: ctx.string })),
		dependencies: { users: Users, settings: Settings },
	});
	class Register extends RegisterBase {
		override async execute({
			users = this.dependencies.users,
			settings = this.dependencies.settings,
		} = {}) {
			const user = await users.create(new User(this.input));
			user.publish();
			return { id: user.id, greeting: `${settings.GREETING}, ${user.name}` };
		}
	}

	test("the use case gets the repository and the environment", async () => {
		expectTypeOf<
			UseCaseDependencies<typeof Register>["settings"]
		>().toEqualTypeOf<Readonly<{ GREETING: string }>>();
		const register = new Register({ name: "Ana" });
		const result = await register.execute();
		expect(result.greeting).toBe("Olá, Ana");
		expect(await Users.findById(result.id)).toBeInstanceOf(User);
	});

	test("events of the entities given to the repository go up to the use case", async () => {
		class Store extends useCaseOf({
			name: "Store",
			blueprint: Input,
			response: Empty,
			dependencies: { users: Users },
		}) {
			override async execute({ users = this.dependencies.users } = {}) {
				const user = new User(this.input);
				user.publish();
				await users.create(user);
				return {};
			}
		}
		const store = new Store({ name: "Bia" });
		await store.execute();
		expect(store.pullEvents().map((event) => event.name)).toEqual(["created"]);
	});

	test("events of an entity a response holds in a variant go up to the use case", async () => {
		const Guest = blueprintOf((ctx) => ({ label: ctx.string }));
		class Find extends useCaseOf({
			name: "Find",
			blueprint: Input,
			response: blueprintOf((ctx) => ({
				owner: variantOf("kind", { user: User, guest: Guest }),
				others: ctx.listOf(variantOf("kind", { user: User, guest: Guest })),
			})),
		}) {
			override async execute() {
				const owner = new User(this.input);
				owner.publish();
				const other = new User({ name: "other" });
				other.publish();
				return {
					owner,
					others: [{ kind: "guest" as const, label: "g" }, other],
				};
			}
		}
		const find = new Find({ name: "Bia" });
		const { owner, others } = await find.execute();

		expect(owner).toBeInstanceOf(User);
		expect(others[0]).toEqual({ kind: "guest", label: "g" });
		expect(
			find.pullEvents().map((event) => (event.entity as User).name),
		).toEqual(["Bia", "other"]);
	});

	test("the repository works only while the use case executes", async () => {
		const register = new Register({ name: "Ana" });
		await expect(register.dependencies.users.count()).rejects.toBeInstanceOf(
			Exception,
		);
	});

	test("execute replaces some methods of a repository, and an environment", async () => {
		const created: string[] = [];
		const register = new Register({ name: "Caio" });
		const result = await register.execute({
			// Only create is replaced; the subclass types `users` as the whole repository.
			users: {
				create: async (user: User) => {
					created.push(user.name);
					return user;
				},
			} satisfies Partial<typeof Users> as typeof Users,
			settings: { GREETING: "Oi" },
		});
		expect(result.greeting).toBe("Oi, Caio");
		expect(created).toEqual(["Caio"]);
		expect(await Users.findById(result.id)).toBeUndefined();
	});

	test("rejects overrides that do not fit the dependency", async () => {
		await expect(
			// @ts-expect-error a function is not a repository
			new Register({ name: "Ana" }).execute({ users: async () => {} }),
		).rejects.toBeInstanceOf(Exception);
		await expect(
			// @ts-expect-error GREETING is required
			new Register({ name: "Ana" }).execute({ settings: {} }),
		).rejects.toBeInstanceOf(Exception);
	});

	test("useCaseOf accepts repositories and environments, nothing else", () => {
		expect(() =>
			useCaseOf({
				name: "Bad",
				blueprint: Input,
				response: Empty,
				// @ts-expect-error not a dependency
				dependencies: { users: {} },
			}),
		).toThrow(InvalidUseCaseDeclaration);
	});
});

describe("extended repositories in use cases", () => {
	class Item extends entityOf(Input, {
		onCreate: () => ItemCreated,
		onDelete: () => ItemDeleted,
	}) {
		publish(): void {
			this.emit(ItemPublished);
		}
	}
	// The annotations avoid a circular inference between the entity and its events.
	const ItemCreated: EventDefinition = eventOf(
		"item.created",
		Item,
		async () => {},
	);
	const ItemDeleted: EventDefinition = eventOf(
		"item.deleted",
		Item,
		async () => {},
	);
	const ItemPublished: EventDefinition = eventOf(
		"item.published",
		Item,
		async () => {},
	);

	const Base = () =>
		repositoryOf({
			entity: Item,
			actions: ["findById", "findManyByName", "create", "delete", "count"],
		});
	type Events = ReturnType<UseCaseLike["pullEvents"]>;
	type UseCaseLike = { pullEvents(): { name: string; entity: object }[] };
	const names = (events: Events) => events.map((event) => event.name);
	const subjects = (events: Events) =>
		events.map((event) => (event.entity as Item).name);

	/** A use case whose `execute` calls `run` with the repository. */
	function useCaseWith<Repository extends ReturnType<typeof Base>, Result>(
		repository: Repository,
		run: (items: Repository) => Promise<Result>,
	) {
		return class Run extends useCaseOf({
			name: "Run",
			blueprint: Empty,
			response: Empty,
			dependencies: { items: repository },
		}) {
			override async execute(_overrides?: unknown) {
				await run(this.dependencies.items as unknown as Repository);
				return {};
			}
		};
	}

	test("a method calling this.create sends its events to the use case", async () => {
		class Items extends RepositoryOf(Base()) {
			async register(name: string): Promise<string> {
				// The item is not given back: its events can go up only through create.
				const item = await this.create(new Item({ name }));
				return item.id;
			}
		}
		const items = new Items();
		const Register = useCaseWith(items, (deps) => deps.register("Ana"));
		const register = new Register({});
		await register.execute();
		expect(names(register.pullEvents())).toEqual(["item.created"]);

		const Direct = useCaseWith(items, (deps) =>
			deps.create(new Item({ name: "Bia" })),
		);
		const direct = new Direct({});
		await direct.execute();
		expect(names(direct.pullEvents())).toEqual(["item.created"]);
	});

	test("a method deleting what it finds sends every onDelete, in order", async () => {
		class Items extends RepositoryOf(Base()) {
			async revoke(name: string): Promise<number> {
				const found = await this.findManyByName(name);
				for (const item of found) await this.delete(item);
				return found.length;
			}
		}
		const items = new Items();
		await items.create(new Item({ name: "Ana" }));
		await items.create(new Item({ name: "Ana" }));
		const Revoke = useCaseWith(items, (deps) => deps.revoke("Ana"));
		const revoke = new Revoke({});
		await revoke.execute();
		expect(names(revoke.pullEvents())).toEqual([
			"item.deleted",
			"item.deleted",
		]);
		expect(await items.count()).toBe(0);
	});

	test("nested methods send each event once, in the order of the calls", async () => {
		class Items extends RepositoryOf(Base()) {
			async make(name: string): Promise<Item> {
				return this.create(new Item({ name }));
			}
			async makeTwice(): Promise<Item> {
				await this.make("first");
				return this.make("second");
			}
			async makeAndPublish(name: string): Promise<Item> {
				const item = await this.create(new Item({ name }));
				item.publish();
				return item;
			}
			async wrapped(name: string): Promise<{ item: Item }> {
				return { item: await this.create(new Item({ name })) };
			}
		}
		const items = new Items();
		const Run = useCaseWith(items, async (deps) => {
			await deps.makeTwice();
			await deps.makeAndPublish("third");
			await deps.wrapped("fourth");
		});
		const run = new Run({});
		await run.execute();
		const events = run.pullEvents();
		expect(names(events)).toEqual([
			"item.created",
			"item.created",
			"item.created",
			"item.published",
			"item.created",
		]);
		expect(subjects(events)).toEqual([
			"first",
			"second",
			"third",
			"third",
			"fourth",
		]);
	});

	test("an override of create replaces it inside the methods of the repository", async () => {
		class Items extends RepositoryOf(Base()) {
			async register(name: string): Promise<Item> {
				return this.create(new Item({ name }));
			}
		}
		const items = new Items();
		const fake: string[] = [];
		const Register = useCaseWith(items, (deps) => deps.register("Caio"));
		const register = new Register({});
		await register.execute({
			items: {
				create: async (item: Item) => {
					fake.push(item.name);
					return item;
				},
			} as unknown as Items,
		});
		expect(fake).toEqual(["Caio"]);
		expect(await items.count()).toBe(0);
		expect(names(register.pullEvents())).toEqual(["item.created"]);
	});

	test("an override of a custom method replaces it, with itself as this", async () => {
		class Items extends RepositoryOf(Base()) {
			async register(name: string): Promise<Item> {
				return this.create(new Item({ name }));
			}
		}
		const items = new Items();
		let received: unknown;
		const override = {
			async register(this: unknown, name: string) {
				received = this;
				return new Item({ name: `${name}!` });
			},
		};
		const Register = useCaseWith(items, (deps) => deps.register("Dani"));
		const register = new Register({});
		await register.execute({ items: override as unknown as Items });
		expect(received).toBe(override);
		expect(await items.count()).toBe(0);
		expect(names(register.pullEvents())).toEqual(["item.created"]);
	});

	test("an overriding method calling super and writing fields works on the real repository", async () => {
		class Items extends RepositoryOf(Base()) {
			created: string[] = [];
			last: string | undefined;
			override async create(item: Item): Promise<Item> {
				const created = await super.create(item);
				this.created.push(item.name);
				this.last = item.name;
				return created;
			}
			async register(name: string): Promise<Item> {
				return this.create(new Item({ name }));
			}
		}
		const items = new Items();
		const Direct = useCaseWith(items, (deps) =>
			deps.create(new Item({ name: "Eva" })),
		);
		const direct = new Direct({});
		await direct.execute();
		expect(names(direct.pullEvents())).toEqual(["item.created"]);
		const Via = useCaseWith(items, (deps) => deps.register("Fabio"));
		const via = new Via({});
		await via.execute();
		expect(names(via.pullEvents())).toEqual(["item.created"]);
		expect(items.created).toEqual(["Eva", "Fabio"]);
		expect(items.last).toBe("Fabio");
	});

	test("the protected members work through the view of the use case", async () => {
		const found: unknown[] = [];
		class Items extends RepositoryOf(Base()) {
			async inspect(item: Item): Promise<void> {
				found.push(await this.provider.count(this.context));
				found.push(this.env);
				const copy = await this.hydrate(this.dataOf(item));
				found.push(copy.id === item.id, copy === item);
			}
		}
		const items = new Items();
		const item = await items.create(new Item({ name: "Gil" }));
		const Inspect = useCaseWith(items, (deps) => deps.inspect(item));
		await new Inspect({}).execute();
		expect(found).toEqual([1, {}, true, false]);
	});

	test("an arrow field calling super works and its entities are collected", async () => {
		class Items extends RepositoryOf(Base()) {
			findNamed = async (name: string) => {
				const [first] = await super.findManyByName(name.trim());
				return first;
			};
		}
		const items = new Items();
		await items.create(new Item({ name: "Hana" }));
		let found: Item | undefined;
		const Find = useCaseWith(items, async (deps) => {
			found = await deps.findNamed(" Hana ");
		});
		const find = new Find({});
		await find.execute();
		expect(found?.name).toBe("Hana");
		expect(names(find.pullEvents())).toEqual([]);
	});

	test("a closure kept by a method fails once the use case ends", async () => {
		class Items extends RepositoryOf(Base()) {
			later(): () => Promise<Item> {
				return () => this.create(new Item({ name: "Iris" }));
			}
		}
		const items = new Items();
		let later: (() => Promise<Item>) | undefined;
		const Keep = useCaseWith(items, async (deps) => {
			later = await deps.later();
		});
		await new Keep({}).execute();
		await expect(later?.()).rejects.toBeInstanceOf(Exception);
		expect(await items.count()).toBe(0);
	});

	test("use cases running together with one repository keep their own events", async () => {
		class Items extends RepositoryOf(Base()) {
			async register(name: string): Promise<Item> {
				await Promise.resolve();
				return this.create(new Item({ name }));
			}
		}
		const items = new Items();
		const Register = (name: string) =>
			new (useCaseWith(items, (deps) => deps.register(name)))({});
		const [first, second] = [Register("Jo"), Register("Kai")];
		await Promise.all([first.execute(), second.execute()]);
		expect(subjects(first.pullEvents())).toEqual(["Jo"]);
		expect(subjects(second.pullEvents())).toEqual(["Kai"]);
		expect(await items.count()).toBe(2);
	});

	test("the events of a call that succeeded stay when the method fails later", async () => {
		class Items extends RepositoryOf(Base()) {
			async createThenFail(name: string): Promise<void> {
				await this.create(new Item({ name }));
				throw new Error("later");
			}
		}
		const items = new Items();
		const Fail = useCaseWith(items, (deps) => deps.createThenFail("Lia"));
		const fail = new Fail({});
		await expect(fail.execute()).rejects.toBeInstanceOf(Exception);
		expect(names(fail.pullEvents())).toEqual(["item.created"]);
	});

	test("outside a use case the methods run as before", async () => {
		class Items extends RepositoryOf(Base()) {
			async register(name: string): Promise<Item> {
				return this.create(new Item({ name }));
			}
		}
		const items = new Items();
		const item = await items.register("Mel");
		expect(await items.count()).toBe(1);
		expect(names(item.pullEvents())).toEqual(["item.created"]);
	});
});

test("a repository exception is caught by instanceof after crossing the use case", async () => {
	const Account = blueprintOf((ctx) => ({ email: ctx.string }));
	class Member extends entityOf(Account, { unique: ["email"] }) {}
	const Members = repositoryOf({ entity: Member, actions: ["create"] });
	class Join extends useCaseOf({
		name: "Join",
		blueprint: Account,
		response: Empty,
		dependencies: { members: Members },
	}) {
		override async execute({ members = this.dependencies.members } = {}) {
			await members.create(new Member(this.input));
			return {};
		}
	}

	await new Join({ email: "ana@example.com" }).execute();
	const error: unknown = await new Join({ email: "ana@example.com" })
		.execute()
		.catch((error: unknown) => error);

	expect(error).toBeInstanceOf(RepositoryUniqueViolation);
	if (!(error instanceof RepositoryUniqueViolation)) throw error;
	expect(error.layer).toBe(ExceptionLayers.UseCase);
	expect(error.details).toMatchObject({ key: "email" });
});
