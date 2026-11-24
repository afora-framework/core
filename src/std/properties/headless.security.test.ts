import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	InvalidPropertyValue,
	recordOf,
	SchemaProperty,
} from "../../index";

/** A JSON Schema of objects in objects, `levels` JSON levels deep, the root included. */
function nestedSchema(levels: number): unknown {
	const objects = Math.floor((levels - 1) / 2);
	return JSON.parse(
		`${'{"type":"object","properties":{"a":'.repeat(objects)}{"type":"string"}${"}}".repeat(objects)}`,
	);
}

/** A JSON Schema of arrays in arrays, `levels` JSON levels deep, the root included. */
function nestedItems(levels: number): unknown {
	return JSON.parse(
		`${'{"type":"array","items":'.repeat(levels - 1)}{"type":"string"}${"}".repeat(levels - 1)}`,
	);
}

describe("SEC-29: depth of a schema held as a value", () => {
	const ContentType = recordOf(
		blueprintOf((ctx) => ({ name: ctx.text, shape: ctx.schema })),
	);

	test("SEC-29: a schema nested deeper than the limit is an issue at safeParse", () => {
		for (const shape of [nestedSchema(3000), nestedItems(129)]) {
			const started = performance.now();
			const result = ContentType.safeParse({ name: "post", shape });
			expect(performance.now() - started).toBeLessThan(100);
			expect(result.issues?.[0]?.message).toContain("is nested too deeply");
			expect(result.issues?.[0]?.path?.[0]).toBe("shape");
		}
		expect(SchemaProperty.safeParse(nestedItems(20000)).issues).toBeDefined();
	});

	test("SEC-29: deserialize refuses a schema nested deeper than the limit", () => {
		expect(() =>
			SchemaProperty.deserialize(JSON.stringify(nestedItems(129))),
		).toThrow("is nested too deeply");
		const deep = `${'{"items":'.repeat(20000)}{}${"}".repeat(20000)}`;
		expect(() => SchemaProperty.deserialize(deep)).toThrow(
			InvalidPropertyValue,
		);
	});

	test("SEC-29: a schema at the limit is accepted and matches quickly", () => {
		for (const shape of [nestedSchema(128), nestedItems(128)]) {
			const result = ContentType.safeParse({ name: "post", shape });
			if (result.issues) throw new Error("expected the schema to be accepted");
			const held = SchemaProperty.deserialize(
				JSON.stringify(result.value.toJSON().shape),
			);
			const started = performance.now();
			expect(held.match({})).toBeDefined();
			expect(held.errors(1).length).toBeGreaterThan(0);
			expect(performance.now() - started).toBeLessThan(200);
		}
	});
});

describe("SEC-35: the constructor of SchemaProperty checks the depth first", () => {
	test("SEC-35: a schema nested far deeper than the limit throws InvalidPropertyValue", () => {
		for (const shape of [
			nestedItems(20000),
			JSON.parse(`${'{"items":'.repeat(20000)}{}${"}".repeat(20000)}`),
		]) {
			expect(() => new SchemaProperty(shape as never)).toThrow(
				InvalidPropertyValue,
			);
			expect(() => new SchemaProperty(shape as never)).toThrow(
				"is nested too deeply",
			);
		}
	});

	test("SEC-35: a value that is not a schema is still rejected", () => {
		for (const value of ["text", 1, null, [], true]) {
			expect(() => new SchemaProperty(value as never)).toThrow(
				InvalidPropertyValue,
			);
		}
		expect(new SchemaProperty({ type: "string" } as never).match("a")).toBe(
			true,
		);
	});
});

/** `count` definitions, each referring twice to the one before, under `keyword`. */
function fanOut(count: number, keyword: "allOf" | "anyOf" | "oneOf"): unknown {
	const defs: Record<string, unknown> = { d0: { type: "number" } };
	for (let index = 1; index <= count; index++) {
		const ref = { $ref: `#/$defs/d${index - 1}` };
		defs[`d${index}`] = { [keyword]: [ref, { ...ref }] };
	}
	return { $defs: defs, $ref: `#/$defs/d${count}` };
}

describe("SEC-51: cost of checking against a schema held as a value", () => {
	const ContentType = recordOf(
		blueprintOf((ctx) => ({ name: ctx.text, shape: ctx.schema })),
	);
	const refused: readonly unknown[] = [
		fanOut(30, "allOf"),
		fanOut(30, "anyOf"),
		fanOut(30, "oneOf"),
		{ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" },
		{
			$defs: {
				a: { allOf: [{ $ref: "#/$defs/b" }] },
				b: { $ref: "#/$defs/a" },
			},
			$ref: "#/$defs/a",
		},
		{ type: "object", properties: { child: { $ref: "#" } } },
		{ type: "string", pattern: "^(a+)+$" },
		{ type: "string", pattern: "^(a|a)*$" },
		{ type: "string", pattern: "^(a*)*b$" },
		{ type: "string", pattern: "^(a?){30}a{30}$" },
		{ type: "string", pattern: "^(a)\\1$" },
		{ type: "string", pattern: "^(?=a+)+$" },
		{ type: "object", patternProperties: { "^(a+)+$": { type: "string" } } },
		{ type: "object", propertyNames: { pattern: "^(\\w+\\s?)*$" } },
		{ type: "string", pattern: `^${"a*".repeat(20)}b$` },
		{ $ref: "#/$defs/missing" },
		{ $dynamicRef: "#a" },
	];

	test("SEC-51: such a schema is an issue at safeParse, quickly", () => {
		for (const shape of refused) {
			const started = performance.now();
			const result = ContentType.safeParse({ name: "post", shape });
			expect(performance.now() - started).toBeLessThan(100);
			expect(result.issues?.[0]?.path?.[0]).toBe("shape");
			expect(SchemaProperty.safeParse(shape).issues).toBeDefined();
		}
	});

	test("SEC-51: the constructor and deserialize refuse it with InvalidPropertyValue", () => {
		for (const shape of refused) {
			expect(() => new SchemaProperty(shape as never)).toThrow(
				InvalidPropertyValue,
			);
			expect(() => SchemaProperty.deserialize(JSON.stringify(shape))).toThrow(
				InvalidPropertyValue,
			);
		}
	});

	test("SEC-51: a schema with references and patterns of ordinary cost is kept and matches", () => {
		const shape = {
			$defs: {
				slug: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 64 },
				date: {
					type: "string",
					pattern:
						"^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?)?$",
				},
				author: {
					type: "object",
					properties: {
						name: { type: "string" },
						slug: { $ref: "#/$defs/slug" },
					},
					required: ["name"],
				},
			},
			type: "object",
			properties: {
				slug: { $ref: "#/$defs/slug" },
				published: { $ref: "#/$defs/date" },
				authors: { type: "array", items: { $ref: "#/$defs/author" } },
				tags: {
					type: "array",
					items: { anyOf: [{ $ref: "#/$defs/slug" }, { type: "integer" }] },
				},
				email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
			},
			required: ["slug"],
		};
		const result = ContentType.safeParse({ name: "post", shape });
		if (result.issues) throw new Error(JSON.stringify(result.issues));
		const held = SchemaProperty.deserialize(JSON.stringify(shape));
		expect(
			held.match({
				slug: "hello-world",
				published: "2026-11-24T10:00:00.5",
				authors: [{ name: "A", slug: "a" }],
				tags: ["x", 1],
				email: "a@b.c",
			}),
		).toBe(true);
		expect(held.match({ slug: "Hello World" })).toBe(false);
		expect(held.errors({ slug: 1 }).length).toBeGreaterThan(0);
	});
});
