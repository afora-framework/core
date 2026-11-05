import * as core from "@afora/core";
import {
	ENTITY_IDENTITY_KEYS,
	RESERVED_ENTITY_KEYS,
	RESERVED_RECORD_KEYS,
	Std,
	StdRecordPlugins,
} from "@afora/core";

/** The kind of JSON Schema a Std property validates; it tells which `with` options apply. */
export type SchemaKind = "string" | "number" | "integer" | "boolean" | "other";

export interface StdPropertyInfo {
	/** The name to use in a spec: `"email"`. */
	readonly name: string;
	/** The class exported by `@afora/core`: `Email`. */
	readonly export: string;
	readonly schemaType: SchemaKind;
	/** Always masked by `toJSON()`. */
	readonly sensitive: boolean;
	/** Makes the key unique (repositories get `findBy<Key>`). */
	readonly unique: boolean;
	/** Absent by default. */
	readonly optional: boolean;
	/** The keys `with` accepts for this property. */
	readonly options: readonly string[];
	/** Whether a spec can use it (the `schema` property needs a TypeBox schema, which JSON cannot carry). */
	readonly usable: boolean;
}

export interface RecordPluginInfo {
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	readonly keys: readonly string[];
	readonly sensitive: readonly string[];
	readonly unique: readonly string[];
	readonly change: readonly string[];
	readonly members: readonly string[];
}

export interface FactoryInfo {
	readonly name: string;
	/** How to write it in a spec. */
	readonly spec: string;
}

export interface Catalog {
	readonly properties: readonly StdPropertyInfo[];
	readonly factories: readonly FactoryInfo[];
	readonly recordPlugins: readonly RecordPluginInfo[];
	/** Keys no record or entity may declare. */
	readonly reservedRecordKeys: readonly string[];
	/** Keys no entity may declare, besides the reserved record keys. */
	readonly reservedEntityKeys: readonly string[];
	/** The keys an entity gets by itself. */
	readonly identityKeys: readonly string[];
	/** The actions a repository can list, and the rule of each. */
	readonly repositoryActions: readonly { action: string; rule: string }[];
	/** Everything `@afora/core` exports; a declaration cannot take one of these names. */
	readonly reservedDeclarationNames: readonly string[];
}

/** The metadata options every property takes. */
const METADATA_OPTIONS = [
	"title",
	"description",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"default",
] as const;
const STRING_OPTIONS = ["min", "max", "pattern"] as const;
const NUMBER_OPTIONS = [
	"min",
	"max",
	"exclusiveMin",
	"exclusiveMax",
	"multipleOf",
] as const;

/** Properties whose class cannot be used from JSON. */
const UNUSABLE = new Set(["schema"]);

interface RuntimeProperty {
	readonly type: {
		readonly name: string;
		readonly sensitive?: boolean;
		readonly unique?: boolean;
		readonly optional?: boolean;
		readonly schema: { readonly type: { Type(): unknown } };
	};
}

function schemaKindOf(schema: unknown): SchemaKind {
	const { type, anyOf } = schema as {
		type?: unknown;
		anyOf?: readonly { type?: unknown }[];
	};
	const types = new Set(
		typeof type === "string" ? [type] : (anyOf ?? []).map((s) => s.type),
	);
	if (types.size !== 1) return "other";
	const [only] = [...types];
	return only === "string" ||
		only === "number" ||
		only === "integer" ||
		only === "boolean"
		? only
		: "other";
}

function optionsOf(kind: SchemaKind): readonly string[] {
	if (kind === "string") return [...METADATA_OPTIONS, ...STRING_OPTIONS];
	if (kind === "number" || kind === "integer") {
		return [...METADATA_OPTIONS, ...NUMBER_OPTIONS];
	}
	return [...METADATA_OPTIONS];
}

function build(): Catalog {
	const exportsOf: [string, unknown][] = Object.entries(
		core as Record<string, unknown>,
	);
	const properties = Object.entries(
		Std.properties as Readonly<Record<string, RuntimeProperty>>,
	).map(([name, Property]): StdPropertyInfo => {
		const schemaType = schemaKindOf(Property.type.schema.type.Type());
		const exported = exportsOf.find(([, value]) => value === Property)?.[0];
		return {
			name,
			export: exported ?? name,
			schemaType,
			sensitive: Property.type.sensitive === true,
			unique: Property.type.unique === true,
			optional: Property.type.optional === true,
			options: optionsOf(schemaType),
			usable: exported !== undefined && !UNUSABLE.has(name),
		};
	});
	return {
		properties,
		factories: Object.keys(Std.factories).map((name) => ({
			name,
			spec:
				name === "enumOf"
					? '{ "enum": ["draft", "published"] } (a field or a property declaration)'
					: name,
		})),
		recordPlugins: StdRecordPlugins.list.map((plugin) => {
			const { description, ...rest } = plugin.toJSON();
			return {
				name: rest.name,
				version: rest.version,
				...(description === undefined ? {} : { description }),
				keys: rest.keys,
				sensitive: rest.sensitive,
				unique: rest.unique,
				change: rest.change,
				members: rest.members,
			};
		}),
		reservedRecordKeys: [...RESERVED_RECORD_KEYS],
		reservedEntityKeys: [...RESERVED_ENTITY_KEYS],
		identityKeys: [...ENTITY_IDENTITY_KEYS],
		repositoryActions: [
			{ action: "findById", rule: "Always available: `id` is unique." },
			{
				action: "findBy<Key>",
				rule: "Only for a unique key: `id`, a key in the entity's `unique`, a field of a unique property (`slug`) or a unique key of a plugin (`email` of `authenticatable`). Gives the entity or undefined.",
			},
			{
				action: "findManyBy<Key>",
				rule: "Only for a key that is not unique. Gives a list. For a key holding an entity, takes the entity or its id.",
			},
			{
				action: "create",
				rule: "Takes an entity or the input that builds one.",
			},
			{ action: "update", rule: "Saves a changed entity." },
			{ action: "delete", rule: "Destroys an entity (soft delete)." },
			{ action: "count", rule: "Counts the entities." },
		],
		reservedDeclarationNames: [...Object.keys(core), "App"].sort(),
	};
}

let cached: Catalog | undefined;

/**
 * What a spec can use, read from `@afora/core` at runtime: the Std
 * properties (and the `with` options each takes), the factories, the Std
 * record plugins, and the reserved keys. Nothing here is a hand-kept list of
 * names.
 */
export function catalog(): Catalog {
	cached ??= build();
	return cached;
}

/** The info of a Std property by its spec name. */
export function stdProperty(name: string): StdPropertyInfo | undefined {
	return catalog().properties.find((property) => property.name === name);
}

/** The info of a Std record plugin by name. */
export function recordPlugin(name: string): RecordPluginInfo | undefined {
	return catalog().recordPlugins.find((plugin) => plugin.name === name);
}
