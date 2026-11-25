import { afterEach, describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	configure,
	entityOf,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	Password,
	type PasswordHasher,
	repositoryOf,
	resetRuntime,
	useCaseOf,
	withRuntime,
} from "../../index";
import { encodePhc } from "../../std/runtime";
import { manualClock } from "../../testing/clock";

const idOf = (prefix: number, n: number) =>
	`0189000${prefix}-0000-7000-8000-${String(n).padStart(12, "0")}`;
const counter = (prefix: number) => {
	let next = 0;
	return () => idOf(prefix, ++next);
};
/** A fake hasher whose hashes carry `byte` in their salt. */
const hasherOf = (byte: number): PasswordHasher => {
	const hash = encodePhc(new Uint8Array(16).fill(byte), new Uint8Array(32));
	return {
		hash: async () => hash,
		verify: async (_plain, given) => given === hash,
		verifySync: (_plain, given) => given === hash,
	};
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const Note = blueprintOf((ctx) => ({ title: ctx.string }));
class Item extends entityOf(Note) {}
const Items = repositoryOf({
	entity: Item,
	actions: ["create", "findById"],
	provider: inMemoryProvider(),
});

const AddBase = useCaseOf({
	name: "Add",
	blueprint: Note,
	response: blueprintOf((ctx) => ({ item: Item, hash: ctx.string })),
	dependencies: { items: Items },
});
class Add extends AddBase {
	override async execute() {
		await tick();
		const item = await this.dependencies.items.create(new Item(this.input));
		await tick();
		const password = await Password.hash("Str0ng!pass");
		return { item, hash: password.value };
	}
}

const parts = {
	entities: { Item },
	repositories: { Items },
	useCases: { Add },
};

afterEach(() => resetRuntime());

describe("applicationOf({ runtime })", () => {
	test("two applications run concurrently, each with its own services", async () => {
		const first = applicationOf({
			name: "First",
			...parts,
			runtime: {
				clock: manualClock("2030-01-01T00:00:00.000Z"),
				idGenerator: counter(1),
				hasher: hasherOf(1),
			},
		});
		const second = applicationOf({
			name: "Second",
			...parts,
			runtime: {
				clock: manualClock("2040-01-01T00:00:00.000Z"),
				idGenerator: counter(2),
				hasher: hasherOf(2),
			},
		});
		const runs = await Promise.all(
			[1, 2, 3].flatMap((n) => [
				first
					.run(Add, { title: `a${n}` })
					.then((out) => ["first", out] as const),
				second
					.run(Add, { title: `b${n}` })
					.then((out) => ["second", out] as const),
			]),
		);
		for (const [app, { item, hash }] of runs) {
			const prefix = app === "first" ? 1 : 2;
			expect(item.id.startsWith(`0189000${prefix}`)).toBe(true);
			expect(item.createdAt).toBe(
				app === "first"
					? "2030-01-01T00:00:00.000Z"
					: "2040-01-01T00:00:00.000Z",
			);
			expect(
				await (app === "first" ? hasherOf(1) : hasherOf(2)).verify("", hash),
			).toBe(true);
		}
		// Outside both applications, the defaults.
		const outside = new Item({ title: "c" });
		expect(outside.id.startsWith("01890001")).toBe(false);
		expect(outside.createdAt.startsWith("2030")).toBe(false);
	});

	test("its repositories run with its services, called directly too", async () => {
		const clock = manualClock("2030-01-01T00:00:00.000Z");
		const app = applicationOf({
			name: "Direct",
			...parts,
			runtime: { clock, idGenerator: counter(3) },
		});
		const item = await app.repositories.Items.create({ title: "a" });
		expect(item.id).toBe(idOf(3, 1));
		expect(item.createdAt).toBe("2030-01-01T00:00:00.000Z");
		const found = await app.repositories.Items.findById(item.id);
		expect(found?.createdAt).toBe("2030-01-01T00:00:00.000Z");
		// The declaration stays usable: an application with only a runtime binds no provider.
		const declared = await Items.create({ title: "c" });
		expect(declared.id.startsWith("01890003")).toBe(false);
	});

	test("withRuntime comes first, configure fills what it does not give", async () => {
		configure({ idGenerator: counter(9) });
		const app = applicationOf({
			name: "Layers",
			...parts,
			runtime: { clock: manualClock("2030-01-01T00:00:00.000Z") },
		});
		const plain = await app.run(Add, { title: "a" });
		expect(plain.item.id).toBe(idOf(9, 1));
		expect(plain.item.createdAt).toBe("2030-01-01T00:00:00.000Z");

		const scoped = await withRuntime(
			{
				clock: manualClock("2050-01-01T00:00:00.000Z"),
				idGenerator: counter(4),
			},
			() => app.run(Add, { title: "b" }),
		);
		expect(scoped.item.id).toBe(idOf(4, 1));
		expect(scoped.item.createdAt).toBe("2050-01-01T00:00:00.000Z");
	});

	test("an application that extends it inherits them, its own winning each service", async () => {
		const base = applicationOf({
			name: "Base",
			...parts,
			runtime: {
				clock: manualClock("2030-01-01T00:00:00.000Z"),
				idGenerator: counter(5),
			},
		});
		const child = applicationOf({
			name: "Child",
			extends: [base],
			runtime: { idGenerator: counter(6) },
		});
		const { item } = await child.run(Add, { title: "a" });
		expect(item.id).toBe(idOf(6, 1));
		expect(item.createdAt).toBe("2030-01-01T00:00:00.000Z");
		expect(child.describe().runtime).toEqual({
			clock: { kind: "opaque" },
			idGenerator: { kind: "opaque" },
		});
		const extended = base.extend();
		expect(extended.describe().runtime).toEqual(base.describe().runtime);
		const again = await extended.run(Add, { title: "b" });
		expect(again.item.id.startsWith("01890005")).toBe(true);
	});

	test("describe shows each service given as opaque, and nothing without one", () => {
		const app = applicationOf({
			name: "Described",
			runtime: { hasher: hasherOf(1) },
		});
		expect(app.describe().runtime).toEqual({ hasher: { kind: "opaque" } });
		expect(applicationOf({ name: "Plain" }).describe().runtime).toBeUndefined();
	});

	test("rejects what is not a runtime service", () => {
		expect(() =>
			applicationOf({ name: "Bad", runtime: { clock: 1 } as never }),
		).toThrow(InvalidApplicationDeclaration);
		expect(() =>
			applicationOf({ name: "Bad", runtime: { other: () => 0 } as never }),
		).toThrow(InvalidApplicationDeclaration);
	});
});
