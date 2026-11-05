import { describe, expect, test } from "bun:test";
import { blueprintOf, entityOf, recordOf, repositoryOf } from "@afora/core";
import { type Spec, validateSpec } from "../src";

/**
 * For the rules that mirror a check of `@afora/core`: a spec that
 * `validateSpec` rejects, and the same declaration written by hand, which the
 * core rejects too.
 */
const cases: {
	rule: string;
	code: string;
	spec: Spec;
	handwritten: () => unknown;
}[] = [
	{
		rule: "reserved record key",
		code: "reserved_key",
		spec: { version: 1, records: { R: { fields: { toJSON: "text" } } } },
		handwritten: () => recordOf(blueprintOf((ctx) => ({ toJSON: ctx.text }))),
	},
	{
		rule: "entity member as a key",
		code: "reserved_key",
		spec: { version: 1, entities: { E: { fields: { destroy: "text" } } } },
		handwritten: () => entityOf(blueprintOf((ctx) => ({ destroy: ctx.text }))),
	},
	{
		rule: "identity key declared on an entity",
		code: "identity_key",
		spec: { version: 1, entities: { E: { fields: { id: "text" } } } },
		handwritten: () =>
			entityOf(blueprintOf((ctx) => ({ id: ctx.text })) as never),
	},
	{
		rule: "unique naming a missing key",
		code: "unknown_field",
		spec: {
			version: 1,
			records: { R: { fields: { a: "text" }, unique: ["b"] } },
		},
		handwritten: () =>
			recordOf(
				blueprintOf((ctx) => ({ a: ctx.text })),
				{
					unique: ["b"] as never,
				},
			),
	},
	{
		rule: "sensitive naming a missing key",
		code: "unknown_field",
		spec: {
			version: 1,
			records: { R: { fields: { a: "text" }, sensitive: ["b"] } },
		},
		handwritten: () =>
			recordOf(
				blueprintOf((ctx) => ({ a: ctx.text })),
				{
					sensitive: ["b"] as never,
				},
			),
	},
	{
		rule: "change naming a missing key",
		code: "unknown_field",
		spec: {
			version: 1,
			records: { R: { fields: { a: "text" }, change: ["b"] } },
		},
		handwritten: () =>
			recordOf(
				blueprintOf((ctx) => ({ a: ctx.text })),
				{
					change: ["b"] as never,
				},
			),
	},
	{
		rule: "a plugin key already declared",
		code: "plugin_conflict",
		spec: {
			version: 1,
			entities: { E: { fields: { tags: "string[]" }, plugins: ["taggable"] } },
		},
		handwritten: () =>
			entityOf(
				blueprintOf((ctx) => ({ tags: ctx.list.string })),
				{ plugins: (ctx) => [ctx.taggable] },
			),
	},
	{
		rule: "an unknown plugin",
		code: "unknown_plugin",
		spec: {
			version: 1,
			entities: { E: { fields: { a: "text" }, plugins: ["flyable"] } },
		},
		handwritten: () =>
			entityOf(
				blueprintOf((ctx) => ({ a: ctx.text })),
				{
					plugins: (ctx) => [
						(ctx as unknown as Record<string, never>).flyable as never,
					],
				},
			),
	},
	{
		rule: "findBy on a key that is not unique",
		code: "action_not_unique",
		spec: {
			version: 1,
			entities: { E: { fields: { name: "text" } } },
			repositories: { Es: { entity: "E", actions: ["findByName"] } },
		},
		handwritten: () => {
			class E extends entityOf(blueprintOf((ctx) => ({ name: ctx.text }))) {}
			return repositoryOf({ entity: E, actions: ["findByName" as never] });
		},
	},
	{
		rule: "findManyBy on a unique key",
		code: "action_unique",
		spec: {
			version: 1,
			entities: { E: { fields: { email: "email" }, unique: ["email"] } },
			repositories: { Es: { entity: "E", actions: ["findManyByEmail"] } },
		},
		handwritten: () => {
			class E extends entityOf(
				blueprintOf((ctx) => ({ email: ctx.email })),
				{
					unique: ["email"],
				},
			) {}
			return repositoryOf({ entity: E, actions: ["findManyByEmail" as never] });
		},
	},
	{
		rule: "findBy on an unknown key",
		code: "action_unknown_key",
		spec: {
			version: 1,
			entities: { E: { fields: { a: "text" } } },
			repositories: { Es: { entity: "E", actions: ["findByNope"] } },
		},
		handwritten: () => {
			class E extends entityOf(blueprintOf((ctx) => ({ a: ctx.text }))) {}
			return repositoryOf({ entity: E, actions: ["findByNope" as never] });
		},
	},
	{
		rule: "an entity held and not in relations",
		code: "missing_relation",
		spec: {
			version: 1,
			entities: {
				U: { fields: { a: "text" } },
				P: { fields: { author: "U" } },
			},
			repositories: { Ps: { entity: "P", actions: ["findById"] } },
		},
		handwritten: () => {
			class U extends entityOf(blueprintOf((ctx) => ({ a: ctx.text }))) {}
			class P extends entityOf(blueprintOf(() => ({ author: U }))) {}
			return repositoryOf({ entity: P, actions: ["findById"] });
		},
	},
	{
		rule: "a relation to an entity that is not held",
		code: "extra_relation",
		spec: {
			version: 1,
			entities: {
				U: { fields: { a: "text" } },
				P: { fields: { b: "text" } },
			},
			repositories: {
				Us: { entity: "U", actions: ["findById"] },
				Ps: { entity: "P", actions: ["findById"], relations: ["Us"] },
			},
		},
		handwritten: () => {
			class U extends entityOf(blueprintOf((ctx) => ({ a: ctx.text }))) {}
			class P extends entityOf(blueprintOf((ctx) => ({ b: ctx.text }))) {}
			const Us = repositoryOf({ entity: U, actions: ["findById"] });
			return repositoryOf({
				entity: P,
				actions: ["findById"],
				relations: [Us] as never,
			});
		},
	},
];

describe("validateSpec rejects what the core rejects", () => {
	for (const { rule, code, spec, handwritten } of cases) {
		test(rule, () => {
			expect(validateSpec(spec).map((issue) => issue.code)).toContain(code);
			expect(handwritten).toThrow();
		});
	}
});
