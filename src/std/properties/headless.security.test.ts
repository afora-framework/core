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
