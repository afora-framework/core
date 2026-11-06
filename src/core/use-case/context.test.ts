import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	Exception,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidUseCaseDeclaration,
	inMemoryProvider,
	optionalOf,
	RepositoryOf,
	RepositoryUniqueViolation,
	repositoryOf,
	type UseCaseContext,
	useCaseOf,
} from "../../index";
import { type ExecutionScope, ScopeKey } from "./scope";

const Empty = blueprintOf(() => ({}));
const Input = blueprintOf((ctx) => ({ name: ctx.string }));
const Request = blueprintOf((ctx) => ({
	userId: ctx.id,
	requestId: ctx.string,
}));
const UserOnly = blueprintOf((ctx) => ({ userId: ctx.id }));
const userId = "0190a6a0-0000-7000-8000-000000000001";

describe("metadata", () => {
	const Taken = exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "Taken",
		message: "Taken",
	});
	const Other = exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "Other",
		message: "Other",
	});

	test("defaults and declared statics are frozen", () => {
		const Plain = useCaseOf({
			name: "Plain",
			blueprint: Empty,
			response: Empty,
		});
		expect(Plain.context).toBeUndefined();
		expect(Plain.description).toBeUndefined();
		expect(Plain.tags).toEqual([]);
		expect(Plain.deprecated).toBe(false);
		expect(Plain.errors).toEqual([]);

		const Full = useCaseOf({
			name: "Full",
			blueprint: Empty,
			response: Empty,
			context: Request,
			description: "Does it.",
			tags: ["a", "b"],
			deprecated: true,
			errors: [Taken, RepositoryUniqueViolation],
		});
		expect(Full.context).toBe(Request);
		expect(Full.description).toBe("Does it.");
		expect(Full.tags).toEqual(["a", "b"]);
		expect(Full.deprecated).toBe(true);
		expect(Full.errors).toEqual([Taken, RepositoryUniqueViolation]);
		expect(Object.isFrozen(Full.tags)).toBe(true);
		expect(Object.isFrozen(Full.errors)).toBe(true);
	});

	test("rejects invalid settings", () => {
		const base = { name: "Bad", blueprint: Empty, response: Empty };
		const bad = (extra: object) => () =>
			useCaseOf({ ...base, ...extra } as never);
		const optionalContext = optionalOf(Request);
		for (const extra of [
			{ context: {} },
			{ context: optionalContext },
			{ description: 1 },
			{ tags: "a" },
			{ tags: ["a", "a"] },
			{ tags: [""] },
			{ tags: [1] },
			{ deprecated: "yes" },
			{ errors: [Error] },
			{ errors: [Taken, Taken] },
			{ errors: Taken },
		]) {
			expect(bad(extra)).toThrow(InvalidUseCaseDeclaration);
		}
		expect(bad({ errors: [Taken, Other] })).not.toThrow();
	});
});

describe("context", () => {
	const Needs = useCaseOf({
		name: "Needs",
		blueprint: Input,
		response: Empty,
		context: Request,
	});
	class Read extends Needs {
		override async execute() {
			return {};
		}
	}

	test("is required, validated and frozen", () => {
		const ok = new Read(
			{ name: "Ana" },
			{ context: { userId, requestId: "r1" } },
		);
		expect(ok.context).toEqual({ userId, requestId: "r1" });
		expect(Object.isFrozen(ok.context)).toBe(true);
		expect(() => new Read({ name: "Ana" }, undefined as never)).toThrow(
			expect.objectContaining({ name: "InvalidUseCaseContext" }),
		);
		try {
			new Read({ name: "Ana" }, { context: { userId: "x" } } as never);
			throw new Error("unreachable");
		} catch (error) {
			expect(error).toBeInstanceOf(Exception);
			const e = error as Exception<{ issues: unknown[] }>;
			expect(e.name).toBe("InvalidUseCaseContext");
			expect(e.layer).toBe(ExceptionLayers.UseCase);
			expect(e.details?.issues.length).toBeGreaterThan(0);
		}
	});

	test("types: required with a context, rejected without", () => {
		expectTypeOf<UseCaseContext<typeof Needs>>().toEqualTypeOf<
			Readonly<{ userId: string; requestId: string }>
		>();
		expectTypeOf<ConstructorParameters<typeof Read>[1]>().toEqualTypeOf<{
			readonly context: { userId: string; requestId: string };
		}>();
		const Plain = useCaseOf({ name: "P", blueprint: Input, response: Empty });
		expectTypeOf<ConstructorParameters<typeof Plain>>().toEqualTypeOf<
			[input: { name: string }]
		>();
		expectTypeOf<UseCaseContext<typeof Plain>>().toEqualTypeOf<undefined>();
	});

	test("is ignored when not declared", () => {
		const Plain = useCaseOf({ name: "P", blueprint: Input, response: Empty });
		class Run extends Plain {
			override async execute() {
				return {};
			}
		}
		const Loose = Run as unknown as new (
			input: unknown,
			options: unknown,
		) => InstanceType<typeof Run>;
		const run = new Loose({ name: "Ana" }, { context: { a: 1 } });
		expect(run.context).toBeUndefined();
	});

	describe("children", () => {
		const seen: Record<string, unknown> = {};
		const Narrow = useCaseOf({
			name: "Narrow",
			blueprint: Empty,
			response: Empty,
			context: UserOnly,
		});
		class NarrowImpl extends Narrow {
			override async execute() {
				seen.narrow = this.context;
				return {};
			}
		}
		const Free = useCaseOf({ name: "Free", blueprint: Empty, response: Empty });
		class FreeImpl extends Free {
			override async execute() {
				seen.free = this.context;
				return {};
			}
		}
		const Parent = useCaseOf({
			name: "Parent",
			blueprint: Empty,
			response: Empty,
			context: Request,
			dependencies: { narrow: NarrowImpl, free: FreeImpl },
		});
		class ParentImpl extends Parent {
			override async execute({
				narrow = this.dependencies.narrow,
				free = this.dependencies.free,
			} = {}) {
				await narrow({});
				await free({});
				return {};
			}
		}

		test("inherit the parent's context, narrowed to their own keys", async () => {
			await new ParentImpl(
				{},
				{ context: { userId, requestId: "r" } },
			).execute();
			expect(seen.narrow).toEqual({ userId });
			expect(seen.free).toBeUndefined();
		});

		test("fail when they need one and the parent has none", async () => {
			const Bare = useCaseOf({
				name: "Bare",
				blueprint: Empty,
				response: Empty,
				dependencies: { narrow: NarrowImpl },
			});
			class BareImpl extends Bare {
				override async execute({ narrow = this.dependencies.narrow } = {}) {
					await narrow({});
					return {};
				}
			}
			await expect(new BareImpl({}).execute()).rejects.toMatchObject({
				name: "InvalidUseCaseContext",
			});
		});
	});
});

describe("execution scope", () => {
	class Item extends entityOf(Input) {}
	class Holder extends entityOf(
		blueprintOf((ctx) => ({ title: ctx.string, item: Item })),
	) {}

	const make = () => {
		const itemsA = inMemoryProvider();
		const itemsB = inMemoryProvider();
		const holdersA = inMemoryProvider();
		const holdersB = inMemoryProvider();
		const Items = repositoryOf({
			entity: Item,
			provider: itemsA,
			actions: ["findById", "create"],
		});
		const Holders = repositoryOf({
			entity: Holder,
			provider: holdersA,
			actions: ["findById", "create"],
			relations: [Items],
		});
		const scope: ExecutionScope = {
			providers: new Map([
				[itemsA, itemsB],
				[holdersA, holdersB],
			]),
		};
		return { Items, Holders, scope };
	};

	/** Runs `run` inside a use case, with the dependencies, under `scope`. */
	const callWith = (
		dependencies: Record<string, unknown>,
		run: (deps: never) => Promise<void>,
		scope?: ExecutionScope,
	) => {
		const Base = useCaseOf({
			name: "Scoped",
			blueprint: Empty,
			response: Empty,
			dependencies: dependencies as never,
		});
		class Run extends Base {
			override async execute(_overrides?: unknown) {
				await run(this.dependencies as never);
				return {};
			}
		}
		const Loose = Run as unknown as new (
			input: unknown,
			options: unknown,
		) => InstanceType<typeof Run>;
		return new Loose({}, { [ScopeKey]: scope }).execute();
	};

	test("repository methods use the scoped provider", async () => {
		const { Items, scope } = make();
		let id = "";
		await callWith(
			{ items: Items },
			async (deps: { items: typeof Items }) => {
				id = (await deps.items.create(new Item({ name: "Ana" }))).id;
				expect(await deps.items.findById(id)).toBeDefined();
			},
			scope,
		);
		expect(await Items.findById(id)).toBeUndefined();
	});

	test("without a scope the declared provider is used", async () => {
		const { Items } = make();
		let id = "";
		await callWith({ items: Items }, async (deps: { items: typeof Items }) => {
			id = (await deps.items.create(new Item({ name: "Ana" }))).id;
		});
		expect(await Items.findById(id)).toBeDefined();
	});

	test("methods of a RepositoryOf subclass use it through this", async () => {
		const { scope, Items } = make();
		class Custom extends RepositoryOf(Items) {
			async make(name: string) {
				return (await this.create(new Item({ name }))).id;
			}
		}
		const custom = new Custom();
		let id = "";
		await callWith(
			{ items: custom },
			async (deps: { items: Custom }) => {
				id = await deps.items.make("Ana");
			},
			scope,
		);
		expect(await custom.findById(id)).toBeUndefined();
	});

	test("relation loading reads related entities from the scoped providers", async () => {
		const { Items, Holders, scope } = make();
		const holder = new Holder({
			title: "t",
			item: new Item({ name: "Ana" }),
		});
		let id = "";
		await callWith(
			{ items: Items, holders: Holders },
			async (deps: { items: typeof Items; holders: typeof Holders }) => {
				await deps.items.create(holder.item);
				id = (await deps.holders.create(holder)).id;
				const found = await deps.holders.findById(id);
				expect(found?.item.name).toBe("Ana");
			},
			scope,
		);
		// Nothing reached the declared providers.
		expect(await Holders.findById(id)).toBeUndefined();
	});

	test("children inherit the scope", async () => {
		const { Items, scope } = make();
		const Child = useCaseOf({
			name: "Child",
			blueprint: Empty,
			response: Empty,
			dependencies: { items: Items },
		});
		let id = "";
		class ChildImpl extends Child {
			override async execute(_overrides?: unknown) {
				id = (await this.dependencies.items.create(new Item({ name: "Ana" })))
					.id;
				return {};
			}
		}
		await callWith(
			{ child: ChildImpl },
			async (deps: { child: (input: object) => Promise<object> }) => {
				await deps.child({});
			},
			scope,
		);
		expect(await Items.findById(id)).toBeUndefined();
	});
});
