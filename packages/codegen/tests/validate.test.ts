import { describe, expect, test } from "bun:test";
import type { ResolvedSpec, Spec } from "../src";
import { validateSpec } from "../src";
import { COLLECTIONS } from "../src/spec/types";
import {
	authSpec,
	blogSpec,
	extendsContext,
	extendsSpec,
	quickstartSpec,
} from "./fixtures";

type Loose = Record<string, unknown>;

/** The blog with `patch` merged over it (a `undefined` value removes the key). */
function blog(patch: Loose): Spec {
	const out: Loose = { ...blogSpec };
	for (const [key, value] of Object.entries(patch)) {
		const base = (blogSpec as unknown as Loose)[key];
		const collection = COLLECTIONS.includes(key as never);
		out[key] =
			collection && value && typeof value === "object" && base
				? { ...(base as object), ...value }
				: value;
	}
	return out as unknown as Spec;
}

function codes(spec: unknown, extended?: Record<string, ResolvedSpec>) {
	return validateSpec(spec, extended).map(
		(i) => `${i.code}@${i.path.join(".")}`,
	);
}

function expectIssue(
	spec: unknown,
	code: string,
	path?: string,
	extended?: Record<string, ResolvedSpec>,
) {
	const issues = validateSpec(spec, extended);
	const found = issues.find(
		(issue) =>
			issue.code === code &&
			(path === undefined || issue.path.join(".") === path),
	);
	expect(
		found,
		`expected ${code}${path ? `@${path}` : ""}, got ${JSON.stringify(issues)}`,
	).toBeDefined();
	expect(found?.message.length).toBeGreaterThan(10);
}

const entity = (more: Loose = {}, fields: Loose = { name: "text" }) =>
	blog({
		entities: { ...blogSpec.entities, Thing: { fields, ...more } },
	});

describe("valid specs", () => {
	test("the fixtures have no issues", () => {
		expect(validateSpec(quickstartSpec)).toEqual([]);
		expect(validateSpec(blogSpec)).toEqual([]);
		expect(validateSpec(authSpec)).toEqual([]);
		expect(validateSpec(extendsSpec, extendsContext)).toEqual([]);
		expect(validateSpec({ version: 1 })).toEqual([]);
	});

	test("never throws", () => {
		for (const value of [
			null,
			1,
			"x",
			[],
			undefined,
			{ version: 1, entities: 3 },
		]) {
			expect(() => validateSpec(value)).not.toThrow();
		}
		expect(validateSpec(null)[0]?.code).toBe("invalid_spec");
	});
});

describe("document", () => {
	test("unknown top-level key", () => {
		expectIssue({ version: 1, widgets: {} }, "unknown_key", "widgets");
	});
	test("version", () => {
		expectIssue({ version: 2 }, "unsupported_version", "version");
		expectIssue({}, "unsupported_version", "version");
	});
	test("useCases is reserved", () => {
		expectIssue(
			{ version: 1, useCases: {} },
			"use_cases_not_supported",
			"useCases",
		);
	});
	test("output.dir stays inside the project", () => {
		expectIssue(
			{ version: 1, output: { dir: "../x" } },
			"invalid_output",
			"output.dir",
		);
		expectIssue(
			{ version: 1, output: { dir: "/abs" } },
			"invalid_output",
			"output.dir",
		);
	});
	test("extends must be loaded", () => {
		expectIssue(
			{ version: 1, extends: ["./nope.json"] },
			"unresolved_extends",
			"extends.0",
		);
		expectIssue({ version: 1, extends: [1] }, "invalid_extends", "extends");
	});
});

describe("names", () => {
	test("declaration names are PascalCase", () => {
		expectIssue(
			blog({ blueprints: { address: { fields: {} } } }),
			"invalid_name",
			"blueprints.address",
		);
	});
	test("a name taken by @afora/core is reserved", () => {
		expectIssue(
			blog({ blueprints: { Email: { fields: {} } } }),
			"reserved_name",
			"blueprints.Email",
		);
		expectIssue(blog({ blueprints: { App: { fields: {} } } }), "reserved_name");
	});
	test("a name is shared by every kind", () => {
		expectIssue(
			blog({ blueprints: { ...blogSpec.blueprints, User: { fields: {} } } }),
			"name_collision",
			"entities.User",
		);
	});
	test("a name taken by an extended spec", () => {
		expectIssue(
			{ ...extendsSpec, blueprints: { Account: { fields: {} } } },
			"name_collision",
			"blueprints.Account",
			extendsContext,
		);
	});
});

describe("extends", () => {
	test("two extended specs declaring one name differently conflict", () => {
		const other: Spec = {
			version: 1,
			name: "other",
			entities: { Account: { fields: { title: "text" } } },
		};
		expectIssue(
			{ version: 1, extends: ["a", "b"] },
			"extends_conflict",
			"extends.1",
			{ a: { spec: authSpec }, b: { spec: other } },
		);
	});
	test("the same declaration reached twice is deduplicated", () => {
		const shared = { spec: authSpec };
		const a: ResolvedSpec = {
			spec: { version: 1, name: "a", extends: ["auth"] },
			extends: { auth: shared },
		};
		const b: ResolvedSpec = {
			spec: { version: 1, name: "b", extends: ["auth"] },
			extends: { auth: shared },
		};
		expect(validateSpec({ version: 1, extends: ["a", "b"] }, { a, b })).toEqual(
			[],
		);
	});
});

describe("fields", () => {
	test("malformed shorthand", () => {
		expectIssue(
			entity({}, { a: "no spaces allowed" }),
			"invalid_field",
			"entities.Thing.fields.a",
		);
	});
	test("an object field has exactly one form", () => {
		expectIssue(
			entity({}, { a: { type: "text", enum: ["x"] } }),
			"invalid_field",
		);
		expectIssue(entity({}, { a: {} }), "invalid_field");
	});
	test("unknown key in a field", () => {
		expectIssue(
			entity({}, { a: { type: "text", wat: 1 } }),
			"unknown_key",
			"entities.Thing.fields.a.wat",
		);
	});
	test("unknown Std type", () => {
		expectIssue(
			entity({}, { a: "emial" }),
			"unknown_type",
			"entities.Thing.fields.a.type",
		);
	});
	test("unknown declaration", () => {
		expectIssue(
			entity({}, { a: "Missing" }),
			"unknown_type",
			"entities.Thing.fields.a.type",
		);
	});
	test("a property that needs a schema cannot be used from JSON", () => {
		expectIssue(entity({}, { a: "schema" }), "unusable_type");
	});
	test("a field cannot be a repository or an environment", () => {
		expectIssue(
			entity({}, { a: "Users" }),
			"wrong_kind",
			"entities.Thing.fields.a.type",
		);
	});
	test("list bounds", () => {
		expectIssue(
			entity({}, { a: { type: "text", list: { minItems: 3, maxItems: 1 } } }),
			"invalid_list",
		);
		expectIssue(
			entity({}, { a: { type: "text", list: { minItems: -1 } } }),
			"invalid_list",
		);
	});
	test("enum values", () => {
		expectIssue(entity({}, { a: { enum: [] } }), "invalid_enum");
		expectIssue(entity({}, { a: { enum: ["x", "x"] } }), "invalid_enum");
		expectIssue(
			entity({}, { a: { enum: ["x"], default: "y" } }),
			"invalid_enum",
		);
	});
	test("field keys must be identifiers", () => {
		expectIssue(entity({}, { "a-b": "text" }), "invalid_key");
	});
	test("opaque properties are declared, not inlined", () => {
		expectIssue(
			entity({}, { a: { ref: "X", opaque: true, import: "./x" } }),
			"invalid_field",
		);
	});
});

describe("reserved keys", () => {
	test("a record member", () => {
		expectIssue(entity({}, { toJSON: "text" }), "reserved_key");
		expectIssue(entity({}, { constructor: "text" }), "reserved_key");
	});
	test("an entity member", () => {
		expectIssue(entity({}, { destroy: "text" }), "reserved_key");
	});
	test("a record member is allowed in a blueprint", () => {
		expect(
			codes(blog({ blueprints: { B: { fields: { set: "text" } } } })),
		).toEqual([]);
	});
	test("identity keys cannot be declared on an entity", () => {
		for (const key of ["id", "createdAt", "updatedAt", "deletedAt"]) {
			expectIssue(
				entity({}, { [key]: "text" }),
				"identity_key",
				`entities.Thing.fields.${key}`,
			);
		}
	});
	test("a record may declare an identity-like key", () => {
		expect(codes(blog({ records: { R: { fields: { id: "id" } } } }))).toEqual(
			[],
		);
	});
});

describe("record options", () => {
	test("unique, sensitive and change must name fields", () => {
		expectIssue(
			entity({ unique: ["nope"] }),
			"unknown_field",
			"entities.Thing.unique.0",
		);
		expectIssue(
			entity({ sensitive: ["nope"] }),
			"unknown_field",
			"entities.Thing.sensitive.0",
		);
		expectIssue(
			entity({ change: ["nope"] }),
			"unknown_field",
			"entities.Thing.change.0",
		);
	});
	test("change cannot name an identity key", () => {
		expectIssue(
			entity({ change: ["id"] }),
			"change_identity",
			"entities.Thing.change.0",
		);
	});
	test("the options may name keys of plugins", () => {
		expect(
			codes(
				entity({
					plugins: ["authenticatable"],
					change: ["password"],
					unique: ["email"],
				}),
			),
		).toEqual([]);
	});
	test("options must be arrays of strings", () => {
		expectIssue(entity({ unique: "name" }), "invalid_option");
	});
	test("unknown key in a declaration", () => {
		expectIssue(entity({ wat: 1 }), "unknown_key", "entities.Thing.wat");
	});
});

describe("plugins", () => {
	test("unknown plugin", () => {
		expectIssue(
			entity({ plugins: ["flyable"] }),
			"unknown_plugin",
			"entities.Thing.plugins.0",
		);
	});
	test("duplicate plugin", () => {
		expectIssue(
			entity({ plugins: ["taggable", "taggable"] }),
			"duplicate_plugin",
		);
	});
	test("a plugin key already declared", () => {
		expectIssue(
			entity({ plugins: ["taggable"] }, { tags: "string[]" }),
			"plugin_conflict",
		);
	});
	test("two plugins with the same key", () => {
		expectIssue(
			entity({ plugins: ["authenticatable"] }, { email: "email" }),
			"plugin_conflict",
		);
	});
});

describe("properties", () => {
	test("exactly one form", () => {
		expectIssue(blog({ properties: { P: {} } }), "invalid_property");
		expectIssue(
			blog({ properties: { P: { base: "text", enum: ["a"] } } }),
			"invalid_property",
		);
	});
	test("unknown base", () => {
		expectIssue(
			blog({ properties: { P: { base: "nope" } } }),
			"unknown_type",
			"properties.P.base",
		);
		expectIssue(blog({ properties: { P: { base: "Nope" } } }), "unknown_type");
	});
	test("base must be a property", () => {
		expectIssue(
			blog({ properties: { P: { base: "User" } } }),
			"wrong_kind",
			"properties.P.base",
		);
	});
	test("opaque needs an import", () => {
		expectIssue(
			blog({ properties: { P: { opaque: true } } }),
			"invalid_property",
			"properties.P.import",
		);
	});
	test("a property cannot be refined from an opaque one", () => {
		expectIssue(
			blog({
				properties: {
					Raw: { opaque: true, import: "./raw" },
					P: { base: "Raw", with: { min: 1 } },
				},
			}),
			"invalid_with",
		);
	});
});

describe("with options", () => {
	test("pattern does not apply to an integer", () => {
		expectIssue(
			blog({ properties: { P: { base: "integer", with: { pattern: "x" } } } }),
			"invalid_with",
			"properties.P.with.pattern",
		);
	});
	test("min and max do not apply to a boolean", () => {
		expectIssue(
			entity({}, { a: { type: "boolean", with: { min: 1 } } }),
			"invalid_with",
		);
	});
	test("an option of an enum", () => {
		expectIssue(
			blog({ properties: { P: { base: "Status", with: { min: 1 } } } }),
			"invalid_with",
		);
	});
	test("values are checked", () => {
		expectIssue(
			entity({}, { a: { type: "text", with: { pattern: "(" } } }),
			"invalid_with",
		);
		expectIssue(
			entity({}, { a: { type: "text", with: { max: -1 } } }),
			"invalid_with",
		);
		expectIssue(
			entity({}, { a: { type: "integer", with: { min: 5, max: 1 } } }),
			"invalid_with",
		);
		expectIssue(
			entity({}, { a: { type: "integer", with: { multipleOf: 0 } } }),
			"invalid_with",
		);
		expectIssue(
			entity({}, { a: { type: "text", with: { description: 1 } } }),
			"invalid_with",
		);
	});
	test("with on a blueprint or entity", () => {
		expectIssue(
			entity({}, { a: { type: "Address", with: { min: 1 } } }),
			"invalid_with",
		);
	});
	test("valid options pass", () => {
		expect(
			codes(
				entity(
					{},
					{
						a: {
							type: "integer",
							with: { min: 1, max: 5, multipleOf: 1, description: "x" },
						},
						b: { type: "text", with: { pattern: "^a", max: 5 } },
					},
				),
			),
		).toEqual([]);
	});
});

describe("cycles", () => {
	test("entities that reference each other", () => {
		const spec = blog({
			entities: {
				A: { fields: { b: "B?" } },
				B: { fields: { a: "A?" } },
			},
		});
		expectIssue(spec, "cycle");
		expect(
			validateSpec(spec).find((i) => i.code === "cycle")?.message,
		).toContain("A -> B -> A");
	});
	test("an entity that holds itself", () => {
		expectIssue(entity({}, { parent: "Thing?" }), "cycle");
	});
	test("properties that are based on each other", () => {
		expectIssue(
			blog({ properties: { P: { base: "Q" }, Q: { base: "P" } } }),
			"cycle",
		);
	});
});

describe("environments", () => {
	test("hold properties only", () => {
		expectIssue(
			blog({ environments: { E: { fields: { A: "User" } } } }),
			"wrong_kind",
		);
		expectIssue(
			blog({
				environments: { E: { fields: { A: { fields: { b: "text" } } } } },
			}),
			"invalid_environment_field",
		);
		expectIssue(
			blog({ environments: { E: { fields: { A: "text[]" } } } }),
			"invalid_environment_field",
		);
	});
});

describe("repositories", () => {
	const repo = (more: Loose, extra: Loose = {}) =>
		blog({
			repositories: {
				...blogSpec.repositories,
				...extra,
				Things: { entity: "User", actions: ["findById"], ...more },
			},
		});
	test("entity must exist and be an entity", () => {
		expectIssue(
			repo({ entity: "Nope" }),
			"unknown_entity",
			"repositories.Things.entity",
		);
		expectIssue(repo({ entity: "Address" }), "unknown_entity");
	});
	test("actions are required and known", () => {
		expectIssue(
			repo({ actions: undefined }),
			"invalid_option",
			"repositories.Things.actions",
		);
		expectIssue(
			repo({ actions: ["fetch"] }),
			"unknown_action",
			"repositories.Things.actions.0",
		);
		expectIssue(repo({ actions: ["create", "create"] }), "duplicate_action");
	});
	test("findBy needs a unique key", () => {
		expectIssue(
			repo({ actions: ["findByName"] }),
			"action_not_unique",
			"repositories.Things.actions.0",
		);
		expectIssue(repo({ actions: ["findByAge"] }), "action_not_unique");
	});
	test("unique keys: id, unique, slug fields and unique plugin keys", () => {
		expect(
			codes(repo({ actions: ["findById", "findByEmail", "findBySlug"] })),
		).toEqual([]);
		expect(
			codes({
				version: 1,
				entities: {
					A: { fields: { name: "text" }, plugins: ["authenticatable"] },
				},
				repositories: {
					As: { entity: "A", actions: ["findByEmail", "findById"] },
				},
			}),
		).toEqual([]);
	});
	test("findManyBy needs a non unique key", () => {
		expectIssue(
			repo({ actions: ["findManyByEmail"] }),
			"action_unique",
			"repositories.Things.actions.0",
		);
		expectIssue(repo({ actions: ["findManyById"] }), "action_unique");
		expectIssue(repo({ actions: ["findManyBySlug"] }), "action_unique");
		expect(
			codes(repo({ actions: ["findManyByName", "findManyByTags"] })),
		).toEqual([]);
	});
	test("unknown key in an action", () => {
		expectIssue(repo({ actions: ["findManyByNope"] }), "action_unknown_key");
	});
	test("relations must cover the entities held, at any depth", () => {
		expectIssue(
			blog({
				repositories: {
					Users: blogSpec.repositories?.Users as never,
					Posts: { entity: "Post", actions: ["findById"] },
				},
			}),
			"missing_relation",
			"repositories.Posts.relations",
		);
		// through a record, a blueprint and an inline object, but not through another entity
		const deep = blog({
			blueprints: {
				Box: { fields: { inner: { fields: { owner: "User?" } } } },
			},
			records: { Wrapper: { fields: { box: "Box" } } },
			entities: {
				...blogSpec.entities,
				Holder: { fields: { wrapper: "Wrapper[]" } },
			},
			repositories: {
				...blogSpec.repositories,
				Holders: { entity: "Holder", actions: ["findById"] },
			},
		});
		expectIssue(deep, "missing_relation", "repositories.Holders.relations");
		expect(
			codes({
				...deep,
				repositories: {
					...((deep as unknown as Loose).repositories as object),
					Holders: {
						entity: "Holder",
						actions: ["findById"],
						relations: ["Users"],
					},
				},
			}),
		).toEqual([]);
	});
	test("extra, duplicate and unknown relations", () => {
		expectIssue(repo({ relations: ["Users"] }, {}), "extra_relation");
		expectIssue(
			blog({
				repositories: {
					...blogSpec.repositories,
					Posts: {
						entity: "Post",
						actions: ["findById"],
						relations: ["Users", "Users"],
					},
				},
			}),
			"invalid_relations",
		);
		expectIssue(
			repo({ relations: ["Nope"] }),
			"unknown_relation",
			"repositories.Things.relations.0",
		);
		expectIssue(repo({ relations: ["Posts"] }), "extra_relation");
	});
	test("an entity held by another entity needs relations only for the first level", () => {
		// Post holds User; Users repository (of User) needs nothing of Post.
		expect(codes(blogSpec)).toEqual([]);
	});
	test("environments must exist", () => {
		expectIssue(
			repo({ environments: ["Nope"] }),
			"unknown_environment",
			"repositories.Things.environments.0",
		);
		expectIssue(repo({ environments: ["User"] }), "unknown_environment");
	});
	test("repository cycles", () => {
		expectIssue(
			blog({
				repositories: {
					Users: { entity: "User", actions: ["findById"], relations: [] },
					Posts: {
						entity: "Post",
						actions: ["findById"],
						relations: ["Users"],
					},
					A: { entity: "User", actions: ["findById"], relations: ["Posts"] },
				},
			}),
			"extra_relation",
		);
	});
});
