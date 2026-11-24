import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
	blueprintOf,
	jsonOf,
	listOf,
	propertyOf,
	ReservedBlueprintKey,
	recordOf,
} from "../../index";
import { setSpecializedParse } from "./parse";

const polluted = Object.prototype as unknown as Record<string, unknown>;
const pollutedArray = Array.prototype as unknown as Record<string, unknown>;

afterEach(() => {
	delete polluted.role;
	delete polluted.name;
	delete polluted.zip;
	delete polluted.kind;
	delete pollutedArray[0];
});

/** Runs `check` with the specialized paths of the parse on, then off. */
function bothPaths(check: () => void): void {
	check();
	const was = setSpecializedParse(false);
	try {
		check();
	} finally {
		setSpecializedParse(was);
	}
}

/** The value of a parse result, or `undefined` when it has issues. */
function parsedValue<Value>(
	result: { readonly value?: Value } | object,
): Value | undefined {
	return (result as { readonly value?: Value }).value;
}

describe("SEC-14: values of object-typed properties", () => {
	const Settings = jsonOf({
		schema: Type.Object(
			{
				role: Type.Union([Type.Literal("user"), Type.Literal("guest")]),
				tags: Type.Optional(Type.Array(Type.String())),
			},
			{ additionalProperties: false },
		),
	});
	class Account extends recordOf(
		blueprintOf((ctx) => ({
			name: ctx.text,
			settings: Settings,
			data: ctx.optional.json,
		})),
	) {}

	test("SEC-14: a record keeps a frozen copy, not the caller's object", () => {
		const input = {
			name: "n",
			settings: { role: "user" as const, tags: ["a"] },
			data: { nested: { list: [1, { deep: true }] } },
		};
		const account = new Account(input);
		expect(account.settings).not.toBe(input.settings);
		expect(Object.isFrozen(account.settings)).toBe(true);
		expect(Object.isFrozen(account.settings.tags)).toBe(true);
		expect(Object.isFrozen(account.data)).toBe(true);
		const data = account.data as { nested: { list: unknown[] } };
		expect(Object.isFrozen(data.nested.list[1])).toBe(true);

		(input.settings as { role: string }).role = "admin";
		input.settings.tags.push("b");
		(input.data.nested.list[1] as { deep: boolean }).deep = false;
		expect(account.settings).toEqual({ role: "user", tags: ["a"] });
		expect(account.toJSON().settings).toEqual({ role: "user", tags: ["a"] });
		expect(data.nested.list[1]).toEqual({ deep: true });
		expect(() => {
			(account.settings as { role: string }).role = "admin";
		}).toThrow();
	});

	test("SEC-14: through every path of the parse", () => {
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				const settings = { role: "guest" as const };
				const account = parsedValue(Account.safeParse({ name: "n", settings }));
				expect(account?.settings).not.toBe(settings);
				expect(Object.isFrozen(account?.settings)).toBe(true);
			}
		});
	});

	test("SEC-14: a blueprint hands back the caller's value, unfrozen", () => {
		const shape = blueprintOf((ctx) => ({ data: ctx.json }));
		const data = { a: 1 };
		const parsed = parsedValue(shape.safeParse({ data })) as { data: unknown };
		expect(parsed.data).toBe(data);
		expect(Object.isFrozen(data)).toBe(false);
	});
});

describe("SEC-15: inherited values", () => {
	const Address = blueprintOf((ctx) => ({
		city: ctx.text,
		zip: ctx.optionalOf(ctx.text),
	}));
	class User extends recordOf(
		blueprintOf((ctx) => ({
			name: ctx.text,
			role: ctx.optionalOf(ctx.text),
			address: Address,
			tags: ctx.list.text,
		})),
	) {}
	const base = () => ({ name: "a", address: { city: "x" }, tags: [] });

	test("SEC-15: a polluted Object.prototype does not fill an optional key", () => {
		polluted.role = "admin";
		polluted.zip = "polluted";
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				const user = new User(base());
				expect(user.role).toBeUndefined();
				expect(Object.hasOwn(user.address, "zip")).toBe(false);
				expect(user.toJSON()).toEqual({
					name: "a",
					address: { city: "x" },
					tags: [],
				});
			}
		});
	});

	test("SEC-15: a polluted Object.prototype does not fill a required key", () => {
		polluted.name = "admin";
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				const { name: _name, ...rest } = base();
				const result = User.safeParse(rest);
				expect(result.issues?.map((issue) => issue.path)).toEqual([["name"]]);
			}
		});
	});

	test("SEC-15: the whole check of a blueprint of properties", () => {
		const Flat = blueprintOf((ctx) => ({
			name: ctx.string,
			role: ctx.optional.string,
		}));
		polluted.role = "admin";
		polluted.name = "admin";
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				expect(parsedValue(Flat.safeParse({ name: "a" }))).toEqual({
					name: "a",
				});
				expect(Flat.safeParse({}).issues?.[0]?.path).toEqual(["name"]);
			}
		});
	});

	test("SEC-15: a polluted Array.prototype does not fill a hole of a list", () => {
		pollutedArray[0] = "polluted";
		bothPaths(() => {
			// biome-ignore lint/suspicious/noSparseArray: the hole is the test
			const result = User.safeParse({ ...base(), tags: [, "b"] });
			expect(result.issues?.[0]?.path).toEqual(["tags", 0]);
		});
	});

	test("SEC-15: a polluted Object.prototype does not choose a variant", () => {
		const Shape = blueprintOf((ctx) => ({
			shape: ctx.variantOf("kind", {
				circle: blueprintOf((c) => ({ r: c.number })),
			}),
		}));
		polluted.kind = "circle";
		bothPaths(() => {
			expect(Shape.safeParse({ shape: { r: 1 } }).issues?.[0]?.path).toEqual([
				"shape",
				"kind",
			]);
		});
	});

	test("SEC-15: a key named after a built-in member is absent when not own", () => {
		const Shape = blueprintOf((ctx) => ({
			toString: ctx.optional.string,
			valueOf: ctx.optional.string,
		}));
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				const empty: unknown = parsedValue(Shape.safeParse({}));
				expect(empty).toEqual({});
				const own: unknown = parsedValue(Shape.safeParse({ toString: "a" }));
				expect(own).toEqual({ toString: "a" });
			}
		});
	});

	test("SEC-15: own values equal to the inherited ones are kept", () => {
		polluted.role = "admin";
		bothPaths(() => {
			const user = new User({ ...base(), role: "admin" });
			expect(user.role).toBe("admin");
		});
	});

	test("SEC-15: a class instance with prototype getters is still accepted", () => {
		class Input {
			get name() {
				return "g";
			}
			get role() {
				return "editor";
			}
			address = { city: "x" };
			tags = [];
		}
		bothPaths(() => {
			for (let index = 0; index < 20; index++) {
				const user = new User(new Input() as never);
				expect(user.name).toBe("g");
				expect(user.role).toBe("editor");
			}
		});
		const Flat = blueprintOf((ctx) => ({ name: ctx.string }));
		class Named {
			get name() {
				return "n";
			}
		}
		for (let index = 0; index < 20; index++) {
			expect(parsedValue(Flat.safeParse(new Named()))).toEqual({ name: "n" });
		}
	});
});

describe("SEC-16: prototype keys of a blueprint", () => {
	test("SEC-16: __proto__, constructor and prototype are reserved", () => {
		const Inner = blueprintOf((ctx) => ({
			isAdmin: ctx.optionalOf(ctx.boolean),
		}));
		for (const key of ["__proto__", "constructor", "prototype"]) {
			expect(() =>
				// biome-ignore lint/suspicious/noExplicitAny: a key the types reject
				blueprintOf((ctx: any) => ({ [key]: Inner, name: ctx.text })),
			).toThrow(ReservedBlueprintKey);
			expect(() =>
				// biome-ignore lint/suspicious/noExplicitAny: a key the types reject
				blueprintOf((ctx: any) => ({ [key]: ctx.text })),
			).toThrow(ReservedBlueprintKey);
		}
		const Named = blueprintOf((ctx) => ({ name: ctx.text }));
		// biome-ignore lint/suspicious/noExplicitAny: a key the types reject
		const Proto = { ["__proto__"]: Inner } as any;
		expect(() =>
			Named.join(
				// biome-ignore lint/suspicious/noExplicitAny: forged to skip the declaration check
				{ ...Named, properties: Proto } as any,
			),
		).toThrow(ReservedBlueprintKey);
	});

	test("SEC-16: an input __proto__ key never sets the prototype", () => {
		const Shape = blueprintOf((ctx) => ({ name: ctx.text }));
		const result = Shape.safeParse(
			JSON.parse('{"__proto__":{"isAdmin":true},"name":"x"}'),
		);
		expect(result.issues?.[0]?.code).toBe("undeclared_key");
	});
});

describe("SEC-27: values too deep for a recursive schema", () => {
	const Node = Type.Cyclic(
		{ Node: Type.Object({ children: Type.Array(Type.Ref("Node")) }) },
		"Node",
	);
	const Tree = propertyOf({ name: "tree", schema: Node });
	const Menu = blueprintOf((ctx) => ({ title: ctx.string, tree: Tree }));
	const deep = (depth: number): unknown =>
		JSON.parse(
			`${'{"children":['.repeat(depth)}{"children":[]}${"]}".repeat(depth)}`,
		);

	test("SEC-27: safeParse and ~standard.validate give issues, after many parses too", async () => {
		const body = { title: "m", tree: deep(50000) };
		const first = Menu.safeParse(body);
		expect(first.issues?.[0]?.path).toEqual(["tree"]);
		for (let index = 0; index < 20; index++) {
			expect(
				Menu.safeParse({ title: "m", tree: { children: [] } }).issues,
			).toBeUndefined();
		}
		const later = Menu.safeParse(body);
		expect(later.issues?.[0]?.path).toEqual(["tree"]);
		const validated = await Menu["~standard"].validate(body);
		expect(
			(validated as { readonly issues?: readonly unknown[] }).issues?.length,
		).toBeGreaterThan(0);
		expect(
			Menu.safeParse({ title: "m", tree: deep(10) }).issues,
		).toBeUndefined();
	});
});

describe("SEC-50: a parse collects a bounded number of issues", () => {
	const MAX = 100;
	const Tags = blueprintOf((ctx) => ({ tags: listOf(ctx.string) }));
	const many = { tags: Array.from({ length: 20_000 }, () => 0) };

	test("SEC-50: safeParse gives the first issues of a long invalid list", () => {
		bothPaths(() => {
			const result = Tags.safeParse(many);
			expect(result.issues).toHaveLength(MAX);
			expect(result.issues?.[0]?.path).toEqual(["tags", 0]);
			expect(result.issues?.at(-1)?.path).toEqual(["tags", MAX - 1]);
		});
	});

	test("SEC-50: ~standard.validate and a record give the same bound", async () => {
		const result = await Tags["~standard"].validate(many);
		expect("issues" in result && result.issues).toHaveLength(MAX);
		class Tagged extends recordOf(Tags) {}
		expect(Tagged.safeParse(many).issues).toHaveLength(MAX);
	});

	test("SEC-50: undeclared keys are bounded too", () => {
		bothPaths(() => {
			const value: Record<string, unknown> = { tags: [] };
			for (let index = 0; index < 20_000; index++) value[`k${index}`] = 0;
			expect(Tags.safeParse(value).issues).toHaveLength(MAX);
		});
	});

	test("SEC-50: a value with fewer issues keeps every one", () => {
		bothPaths(() => {
			const result = Tags.safeParse({ tags: [0, "a", 1, 2] });
			expect(result.issues?.map((issue) => issue.path)).toEqual([
				["tags", 0],
				["tags", 2],
				["tags", 3],
			]);
		});
	});
});

describe("SEC-52: depth of the values a record keeps", () => {
	const Meta = propertyOf({ name: "meta", schema: Type.Unknown() });
	const Plain = recordOf(
		blueprintOf((ctx) => ({ title: ctx.string, meta: Meta })),
		{ change: ["meta"] },
	);
	const Secret = recordOf(
		blueprintOf((ctx) => ({ title: ctx.string, meta: Meta })),
		{ sensitive: ["meta"] },
	);
	const deep = (depth: number): unknown =>
		JSON.parse("[".repeat(depth) + "]".repeat(depth));

	test("SEC-52: a value nested deeper than 1000 is an issue at the key, on every path", () => {
		bothPaths(() => {
			for (const Record of [Plain, Secret]) {
				for (let index = 0; index < 20; index++) {
					for (const depth of [1001, 5000, 50000]) {
						const started = performance.now();
						const issue = Record.safeParse({ title: "t", meta: deep(depth) })
							.issues?.[0];
						expect(performance.now() - started).toBeLessThan(100);
						expect(issue?.message).toBe("is nested too deeply");
						expect(issue?.path).toEqual(["meta"]);
					}
					expect(
						Record.safeParse({ title: "t", meta: { a: [1] } }).issues,
					).toBeUndefined();
				}
			}
		});
		const kept = new Plain({ title: "t", meta: [] });
		expect(() => kept.change.meta(deep(5000))).toThrow("is nested too deeply");
		expect(() => new Plain({ title: "t", meta: deep(5000) })).toThrow(
			"is nested too deeply",
		);
	});

	test("SEC-52: a value at the limit is kept and can be output", () => {
		for (const Record of [Plain, Secret]) {
			const result = Record.safeParse({ title: "t", meta: deep(1000) });
			const value = parsedValue<{ toJSON(): unknown }>(result);
			if (!value) throw new Error("expected the value to be kept");
			expect(() => value.toJSON()).not.toThrow();
			expect(() => JSON.stringify(value)).not.toThrow();
		}
	});

	test("SEC-52: a sensitive key masks a deep object of any kind without throwing", () => {
		class Box {
			constructor(readonly inner: unknown) {}
		}
		let box: unknown = 1;
		for (let index = 0; index < 50000; index++) box = new Box(box);
		const result = Secret.safeParse({ title: "t", meta: box });
		const value = parsedValue<{ toJSON(): { meta: unknown } }>(result);
		if (!value) throw new Error("expected the value to be kept");
		expect(() => JSON.stringify(value.toJSON())).not.toThrow();
	});
});
