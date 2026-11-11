import { describe, expect, test } from "bun:test";
import { providerDescriptionOf } from "../../experimental";
import {
	InvalidRepositoryDeclaration,
	inMemoryProvider,
	providerOf,
} from "../../index";

const make = (options?: unknown, name: unknown = "custom") =>
	providerOf({
		name: name as string,
		options: options as never,
		create: () => inMemoryProvider(),
	});

describe("providerOf", () => {
	test("calls create once with the options and returns its provider unchanged", () => {
		const created = inMemoryProvider();
		let calls = 0;
		let seen: unknown;
		const provider = providerOf({
			name: "custom",
			options: { url: "x", tags: ["a"] },
			create: (options) => {
				calls++;
				seen = options;
				return created;
			},
		});
		expect(provider).toBe(created);
		expect(calls).toBe(1);
		expect(seen).toEqual({ url: "x", tags: ["a"] });
		expect(providerDescriptionOf(provider)).toEqual({
			kind: "provider",
			name: "custom",
			options: { url: "x", tags: ["a"] },
		});
		expect(Object.keys(provider)).toEqual(Object.keys(inMemoryProvider()));
	});

	test("options default to an empty object", () => {
		expect(providerDescriptionOf(make(undefined))).toEqual({
			kind: "provider",
			name: "custom",
			options: {},
		});
	});

	test("the descriptor is an immutable deep copy", () => {
		const options = { nested: { list: [1, 2] } };
		const provider = make(options);
		options.nested.list.push(3);
		const description = providerDescriptionOf(provider);
		expect(description).toEqual({
			kind: "provider",
			name: "custom",
			options: { nested: { list: [1, 2] } },
		});
		expect(Object.isFrozen(description)).toBe(true);
		const copy = (
			description as unknown as { options: { nested: { list: number[] } } }
		).options;
		expect(Object.isFrozen(copy)).toBe(true);
		expect(Object.isFrozen(copy.nested)).toBe(true);
		expect(Object.isFrozen(copy.nested.list)).toBe(true);
		expect(() => copy.nested.list.push(4)).toThrow();
		expect(providerDescriptionOf(provider)).toBe(description);
	});

	test("rejects invalid names, options and providers", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const invalid: (() => unknown)[] = [
			() => make({}, ""),
			() => make({}, "  "),
			() => make({}, 1),
			() => make({ n: Number.NaN }),
			() => make({ n: Number.POSITIVE_INFINITY }),
			() => make({ f: () => 1 }),
			() => make({ u: undefined }),
			() => make({ d: new Date() }),
			() => make({ s: Symbol("x") }),
			() => make(cyclic),
			() => make([1]),
			() => make("text"),
			() => providerOf({ name: "x", create: () => ({}) as never }),
			() => providerOf({ name: "x", create: () => null as never }),
			() => providerOf(undefined as never),
		];
		for (const attempt of invalid) {
			expect(attempt).toThrow(InvalidRepositoryDeclaration);
		}
	});

	test("an unnamed provider is opaque", () => {
		expect(providerDescriptionOf({ ...inMemoryProvider() })).toEqual({
			kind: "opaque",
		});
	});
});
