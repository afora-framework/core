import { describe, expect, test } from "bun:test";
import * as core from "@afora/core";
import {
	ENTITY_IDENTITY_KEYS,
	RESERVED_ENTITY_KEYS,
	RESERVED_RECORD_KEYS,
	Std,
	StdRecordPlugins,
} from "@afora/core";
import { Value } from "typebox/value";
import { catalog, specSchema } from "../src";
import {
	authSpec,
	blogSpec,
	extendsSpec,
	kitchenSpec,
	quickstartSpec,
} from "./fixtures";

describe("catalog", () => {
	const c = catalog();

	test("is read from @afora/core, not kept by hand", () => {
		expect(c.properties.map((p) => p.name)).toEqual(
			Object.keys(Std.properties),
		);
		expect(c.factories.map((f) => f.name)).toEqual(Object.keys(Std.factories));
		expect(c.recordPlugins.map((p) => p.name)).toEqual(
			StdRecordPlugins.list.map((p) => p.name),
		);
		expect(c.reservedRecordKeys).toEqual([...RESERVED_RECORD_KEYS]);
		expect(c.reservedEntityKeys).toEqual([...RESERVED_ENTITY_KEYS]);
		expect(c.identityKeys).toEqual([...ENTITY_IDENTITY_KEYS]);
	});

	test("properties carry their flags, export and options", () => {
		const get = (name: string) => c.properties.find((p) => p.name === name);
		expect(get("password")).toMatchObject({
			sensitive: true,
			export: "Password",
			schemaType: "string",
		});
		expect(get("slug")).toMatchObject({ unique: true });
		expect(get("updatedAt")).toMatchObject({ optional: true });
		expect(get("integer")).toMatchObject({
			export: "Integer",
			schemaType: "integer",
		});
		expect(get("integer")?.options).toContain("multipleOf");
		expect(get("integer")?.options).not.toContain("pattern");
		expect(get("email")?.options).toContain("pattern");
		expect(get("boolean")?.options).not.toContain("min");
		expect(get("schema")?.usable).toBe(false);
		expect(
			c.properties.filter((p) => p.name !== "schema").every((p) => p.usable),
		).toBe(true);
	});

	test("every export is the very class of Std.properties", () => {
		for (const property of c.properties) {
			expect((core as Record<string, unknown>)[property.export]).toBe(
				(Std.properties as Record<string, unknown>)[property.name],
			);
		}
	});

	test("every option the catalog lists is accepted by Property.with", () => {
		const sample: Record<string, unknown> = {
			title: "t",
			description: "d",
			examples: [],
			deprecated: true,
			readOnly: true,
			writeOnly: true,
			min: 1,
			max: 9,
			pattern: ".",
			exclusiveMin: 1,
			exclusiveMax: 9,
			multipleOf: 1,
		};
		for (const property of c.properties.filter((p) => p.usable)) {
			const Property = (
				Std.properties as Record<string, { with(o: unknown): unknown }>
			)[property.name];
			for (const option of property.options) {
				if (option === "default") continue;
				expect(() =>
					Property?.with({ [option]: sample[option] }),
				).not.toThrow();
			}
		}
	});

	test("plugins come from toJSON()", () => {
		const auth = c.recordPlugins.find((p) => p.name === "authenticatable");
		expect(auth).toMatchObject({
			keys: ["email", "password"],
			unique: ["email"],
			sensitive: ["password"],
			change: ["password"],
		});
		expect(auth?.members).toContain("verifyPassword");
	});

	test("reserves the names @afora/core exports", () => {
		expect(c.reservedDeclarationNames).toContain("Email");
		expect(c.reservedDeclarationNames).toContain("App");
	});

	test("is JSON", () => {
		expect(JSON.parse(JSON.stringify(c))).toEqual(c);
	});
});

describe("specSchema", () => {
	test("is a JSON Schema with the definition of a field", () => {
		const schema = JSON.parse(JSON.stringify(specSchema));
		expect(schema.type).toBe("object");
		expect(schema.$defs.Field.anyOf).toHaveLength(4);
		expect(Object.keys(schema.properties)).toEqual(
			expect.arrayContaining([
				"version",
				"properties",
				"entities",
				"repositories",
				"useCases",
				"extends",
				"output",
			]),
		);
	});
});

describe("specSchema against the validator", () => {
	const valid = [quickstartSpec, blogSpec, authSpec, extendsSpec, kitchenSpec];
	for (const [index, spec] of valid.entries()) {
		test(`accepts the fixture ${index + 1}`, () => {
			expect(Value.Check(specSchema, spec)).toBe(true);
		});
	}
	test("rejects what is structurally wrong", () => {
		expect(Value.Check(specSchema, { version: 2 })).toBe(false);
		expect(
			Value.Check(specSchema, {
				version: 1,
				entities: { user: { fields: {} } },
			}),
		).toBe(false);
		expect(Value.Check(specSchema, { version: 1, widgets: {} })).toBe(false);
		expect(
			Value.Check(specSchema, {
				version: 1,
				entities: { A: { fields: { x: { type: "text", enum: ["a"] } } } },
			}),
		).toBe(false);
	});
});
