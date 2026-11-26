import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { jsonSchemaOf, toOpenAPI } from "@afora/core";
import { catalog, generate, idWireTypeOf, type Spec, specSchema } from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const strategies = catalog().idStrategies;

describe("the wire type of an id", () => {
	test("every value the schema takes for id is in the catalog, with a wire type", () => {
		const schema = JSON.stringify(specSchema);
		for (const { name } of strategies) {
			expect(schema).toContain(`"const":"${name}"`);
		}
		expect(strategies.map((s) => [s.name, s.wire])).toEqual([
			["uuid7", "string"],
			["uuid", "string"],
			["key", "string"],
			["serial", "integer"],
		]);
	});

	test("idWireTypeOf reads it from a declaration, string when id is left out", () => {
		expect(idWireTypeOf({})).toBe("string");
		expect(idWireTypeOf({ id: "key" })).toBe("string");
		expect(idWireTypeOf({ id: "serial" })).toBe("integer");
	});

	test("toOpenAPI and jsonSchemaOf give the id the type the spec declares", async () => {
		const spec: Spec = {
			version: 1,
			name: "Ids",
			entities: {
				Plain: { fields: { name: "text" } },
				Legacy: { fields: { name: "text" }, id: "uuid" },
				Setting: { fields: { value: "text" }, id: "key" },
				Ticket: { fields: { title: "text" }, id: "serial" },
			},
			repositories: {
				Plains: { entity: "Plain", actions: ["create", "findById"] },
				Legacies: { entity: "Legacy", actions: ["create", "findById"] },
				Settings: { entity: "Setting", actions: ["create", "findById"] },
				Tickets: { entity: "Ticket", actions: ["create", "findById"] },
			},
		} as Spec;
		const dir = await makeProject(generate(spec));
		projects.push(dir);
		const domain = await import(join(dir, "src/domain/index.ts"));
		for (const [name, decl] of Object.entries(spec.entities ?? {})) {
			const wire = idWireTypeOf(decl);
			const entity = domain[name];
			const { schemas } = toOpenAPI({ [name]: entity }) as unknown as {
				schemas: Record<string, { properties: { id: { type?: string } } }>;
			};
			const fromOpenAPI = schemas[name]?.properties.id;
			const fromJsonSchema = (
				jsonSchemaOf(entity) as {
					properties: { id: { type?: string } };
				}
			).properties.id;
			expect(fromOpenAPI?.type).toBe(wire);
			expect(fromJsonSchema.type).toBe(wire);
		}
	});
});
