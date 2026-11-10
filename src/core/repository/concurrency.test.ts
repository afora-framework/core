import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	type EventDefinition,
	entityOf,
	eventOf,
	Id,
	ImmutableEntityKey,
	InvalidRepositoryDeclaration,
	InvalidRepositoryIncrement,
	type IRepositoryProvider,
	inMemoryProvider,
	RepositoryConcurrencyConflict,
	RepositoryEntityNotFound,
	ReservedEntityKey,
	repositoryOf,
	statusOf,
	useCaseOf,
} from "../../index";

class Doc extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		change: ["title"],
		versioned: true,
	},
) {}

class Plain extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		change: ["title"],
	},
) {}

class Counter extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		views: ctx.integer,
		seconds: ctx.optionalOf(ctx.number),
		label: ctx.optionalOf(ctx.string),
	})),
	{ change: ["views", "seconds", "label"] },
) {}

class VersionedCounter extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, views: ctx.integer })),
	{ change: ["views", "name"], versioned: true },
) {}

class Tally extends entityOf(
	blueprintOf((ctx) => ({ count: ctx.integer })),
	{
		change: ["count"],
		onCreate: () => TallyCreated,
		onUpdate: () => TallyUpdated,
	},
) {}
const TallyCreated: EventDefinition = eventOf("created", Tally);
const TallyUpdated: EventDefinition = eventOf("updated", Tally);

describe("versioned entities", () => {
	test("have a read-only version, 1 when built, absent elsewhere", () => {
		const doc = new Doc({ title: "a" });
		expect(doc.version).toBe(1);
		expect(doc.toJSON()).toMatchObject({ version: 1, title: "a" });
		expectTypeOf(doc.version).toEqualTypeOf<number>();
		const plain = new Plain({ title: "a" });
		expect("version" in plain.toJSON()).toBe(false);
		// @ts-expect-error not versioned
		void plain.version;
		expect(new Doc({ title: "a", version: 3 }).version).toBe(3);
		expect(Doc.safeParse({ title: "a", version: 0 }).issues).toBeDefined();
		const change = doc.change as unknown as Record<string, unknown>;
		expect(change.version).toBeUndefined();
	});

	test("reserve version and keep it out of change", () => {
		expect(() =>
			entityOf(
				blueprintOf((ctx) => ({ version: ctx.integer })),
				{
					versioned: true,
				},
			),
		).toThrow(ReservedEntityKey);
		expect(() =>
			entityOf(
				blueprintOf((ctx) => ({ title: ctx.string })),
				{
					versioned: true,
					change: ["version"] as never,
				},
			),
		).toThrow(ImmutableEntityKey);
		// Not versioned: an ordinary key.
		const Free = entityOf(
			blueprintOf((ctx) => ({ version: ctx.integer })),
			{
				change: ["version"],
			},
		);
		expect(new Free({ version: 2 }).change.version(3).version).toBe(3);
	});

	test("update checks and bumps the version", async () => {
		const Docs = repositoryOf({
			entity: Doc,
			actions: ["create", "update", "findById"],
		});
		const doc = await Docs.create({ title: "a" });
		const first = (await Docs.findById(doc.id)) as Doc;
		const second = (await Docs.findById(doc.id)) as Doc;
		await Docs.update(first.change.title("b"));
		expect(first.version).toBe(2);
		const error = await Docs.update(second.change.title("c")).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(RepositoryConcurrencyConflict);
		expect((error as { details: unknown }).details).toEqual({
			id: doc.id,
			expected: 1,
			actual: 2,
		});
		expect(statusOf(error)).toBe(409);
		const stored = (await Docs.findById(doc.id)) as Doc;
		expect([stored.title, stored.version]).toEqual(["b", 2]);
	});

	test("concurrent updates: exactly one conflict", async () => {
		const Docs = repositoryOf({
			entity: Doc,
			actions: ["create", "update", "findById"],
		});
		const { id } = await Docs.create({ title: "a" });
		const [a, b] = (await Promise.all([
			Docs.findById(id),
			Docs.findById(id),
		])) as [Doc, Doc];
		const results = await Promise.allSettled([
			Docs.update(a.change.title("x")),
			Docs.update(b.change.title("y")),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
			RepositoryConcurrencyConflict,
		);
	});

	test("soft delete and restore check and bump it", async () => {
		const Docs = repositoryOf({
			entity: Doc,
			actions: ["create", "update", "delete", "restore", "findById"],
			deletion: "soft",
		});
		const doc = await Docs.create({ title: "a" });
		const stale = (await Docs.findById(doc.id)) as Doc;
		await Docs.delete(doc);
		expect(doc.version).toBe(2);
		const restored = await Docs.restore(doc.id);
		expect(restored.version).toBe(3);
		expect(
			await Docs.update(stale.change.title("b")).catch((error) => error),
		).toBeInstanceOf(RepositoryConcurrencyConflict);
		expect(await Docs.delete(stale).catch((error) => error)).toBeInstanceOf(
			RepositoryConcurrencyConflict,
		);
	});

	test("a provider without versioning is refused on the first write", async () => {
		const base = inMemoryProvider();
		const provider: IRepositoryProvider = {
			...base,
			capabilities: { transactions: true },
			update: base.update.bind(base),
		};
		const Docs = repositoryOf({
			entity: Doc,
			actions: ["create", "update"],
			provider,
		});
		const doc = await Docs.create({ title: "a" });
		const error = await Docs.update(doc).catch((caught) => caught);
		expect(error).toBeInstanceOf(InvalidRepositoryDeclaration);
		expect((error as Error).message).toContain("capabilities.versioning");
	});

	test("the std update use case works with versioned entities", async () => {
		const Docs = repositoryOf({
			entity: Doc,
			actions: ["create", "update", "findById"],
		});
		const doc = await Docs.create({ title: "a" });
		const Rename = useCaseOf({
			name: "Rename",
			blueprint: blueprintOf((ctx) => ({ id: ctx.string, title: ctx.string })),
			response: blueprintOf((ctx) => ({ version: ctx.integer })),
			dependencies: { Docs },
		});
		class RenameDoc extends Rename {
			override async execute(deps = this.dependencies) {
				const found = (await deps.Docs.findById(this.input.id)) as Doc;
				const saved = await deps.Docs.update(
					found.change.title(this.input.title),
				);
				return { version: saved.version };
			}
		}
		expect(await new RenameDoc({ id: doc.id, title: "b" }).execute()).toEqual({
			version: 2,
		});
	});
});

describe("increment", () => {
	const make = () =>
		repositoryOf({
			entity: Counter,
			actions: ["create", "increment", "update", "findById"],
		});

	test("adds the deltas atomically and stamps updatedAt", async () => {
		const Counters = make();
		const counter = await Counters.create({ name: "a", views: 1 });
		const next = await Counters.increment(counter.id, {
			views: 2,
			seconds: 1.5,
		});
		expect([next.views, next.seconds]).toEqual([3, 1.5]);
		expect(next.updatedAt).toBeDefined();
		expect((await Counters.increment(next, { views: -1 })).views).toBe(2);
	});

	test("N concurrent increments sum to N", async () => {
		const Counters = make();
		const { id } = await Counters.create({ name: "a", views: 0 });
		await Promise.all(
			Array.from({ length: 50 }, () => Counters.increment(id, { views: 1 })),
		);
		expect((await Counters.findById(id))?.views).toBe(50);
	});

	test("a missing id is not found, or created with create", async () => {
		const Counters = make();
		expect(
			await Counters.increment(Id.generate().value, { views: 1 }).catch(
				(e) => e,
			),
		).toBeInstanceOf(RepositoryEntityNotFound);
		const day = Id.generate().value;
		const created = await Counters.increment(
			day,
			{ views: 1 },
			{ create: { name: "day" } },
		);
		expect([created.id, created.views, created.name]).toEqual([day, 1, "day"]);
		expect(created.updatedAt).toBeUndefined();
		const again = await Counters.increment(
			day,
			{ views: 1 },
			{ create: { name: "day" } },
		);
		expect(again.views).toBe(2);
	});

	test("concurrent creates lose nothing", async () => {
		const Counters = make();
		const id = Id.generate().value;
		await Promise.all(
			Array.from({ length: 20 }, () =>
				Counters.increment(id, { views: 1 }, { create: { name: "k" } }),
			),
		);
		expect((await Counters.findById(id))?.views).toBe(20);
	});

	test("only numeric keys of the change list, at type level and at runtime", async () => {
		const Counters = make();
		const { id } = await Counters.create({ name: "a", views: 0 });
		for (const deltas of [
			{ name: 1 },
			{ label: 1 },
			{ views: "1" },
			{ views: Number.NaN },
			{},
		]) {
			const error = await Counters.increment(id, deltas as never).catch(
				(caught) => caught,
			);
			expect(error).toBeInstanceOf(InvalidRepositoryIncrement);
			expect(statusOf(error)).toBe(400);
		}
		// @ts-expect-error not in the change list
		void (() => Counters.increment(id, { name: 1 }));
		// @ts-expect-error not a number
		void (() => Counters.increment(id, { label: 1 }));
	});

	test("bumps the version, so a stale update conflicts", async () => {
		const Counters = repositoryOf({
			entity: VersionedCounter,
			actions: ["create", "increment", "update", "findById"],
		});
		const counter = await Counters.create({ name: "a", views: 0 });
		const next = await Counters.increment(counter.id, { views: 1 });
		expect(next.version).toBe(2);
		expect(
			await Counters.update(counter.change.name("b")).catch((e) => e),
		).toBeInstanceOf(RepositoryConcurrencyConflict);
		const created = await Counters.increment(
			Id.generate().value,
			{ views: 2 },
			{ create: { name: "x" } },
		);
		expect([created.version, created.views]).toEqual([1, 2]);
	});

	test("emits onCreate and onUpdate, routed through use cases", async () => {
		const Tallies = repositoryOf({ entity: Tally, actions: ["increment"] });
		const Bump = useCaseOf({
			name: "Bump",
			blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
			response: blueprintOf((ctx) => ({ count: ctx.integer })),
			dependencies: { Tallies },
		});
		class BumpTally extends Bump {
			override async execute(deps = this.dependencies) {
				const tally = await deps.Tallies.increment(
					this.input.id,
					{ count: 1 },
					{ create: {} },
				);
				return { count: tally.count };
			}
		}
		const id = Id.generate().value;
		const first = new BumpTally({ id });
		expect(await first.execute()).toEqual({ count: 1 });
		expect(first.pullEvents().map((event) => event.name)).toEqual(["created"]);
		const second = new BumpTally({ id });
		expect(await second.execute()).toEqual({ count: 2 });
		expect(second.pullEvents().map((event) => event.name)).toEqual(["updated"]);
	});

	test("needs a provider with increment", () => {
		const { increment: _increment, ...rest } = inMemoryProvider();
		expect(() =>
			repositoryOf({
				entity: Counter,
				actions: ["increment"],
				provider: rest as IRepositoryProvider,
			}),
		).toThrow(InvalidRepositoryDeclaration);
	});
});
