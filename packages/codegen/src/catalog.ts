import * as core from "@afora/core";
import {
	ENTITY_IDENTITY_KEYS,
	RESERVED_ENTITY_KEYS,
	RESERVED_RECORD_KEYS,
	Std,
	StdRecordPlugins,
} from "@afora/core";

/** The key a versioned entity adds to its identity. */
const VERSION_KEY = "version";

/**
 * The identity keys of an entity declaration: those of every entity, and
 * `version` when it is `versioned`.
 */
export function identityKeysOf(spec: {
	readonly versioned?: unknown;
}): readonly string[] {
	const keys = catalog().identityKeys;
	return spec.versioned === true ? [...keys, VERSION_KEY] : keys;
}

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

/** A standard use case: what its repository and its entity must have. */
export interface GenericUseCaseInfo {
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	/** The actions the repository must declare. */
	readonly actions: readonly string[];
	/** The record plugins the entity must have. */
	readonly plugins: readonly string[];
	/** The options it takes, beside name, description, tags, deprecated and errors. */
	readonly options: readonly string[];
}

export interface FactoryInfo {
	readonly name: string;
	/** How to write it in a spec. */
	readonly spec: string;
}

/** A stage `@afora/core` ships in `StdStages`. */
interface StageInfo {
	/** The name `transform` or `sink` refers to in a pipe. */
	readonly name: string;
	readonly kind: "transform" | "sink";
	readonly builtin: true;
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
	/** The values of `ExceptionLayers`: what an exception's `layer` may be. */
	readonly exceptionLayers: readonly string[];
	/** Exceptions `@afora/core` exports: a use case may list them in `errors` and `ensure` them without declaring them. */
	readonly coreExceptions: readonly string[];
	/** The built-in stages (`StdStages`) a pipe may name; others come from the `stages` option. */
	readonly stages: readonly StageInfo[];
	/** The built-in event policies (`StdEventPolicies`) a command may name; others come from the `policies` option. */
	readonly policies: readonly {
		readonly name: string;
		readonly builtin: true;
	}[];
	/** Everything `@afora/core` exports; a declaration cannot take one of these names. */
	readonly reservedDeclarationNames: readonly string[];
	/** The standard use cases a use case declaration can name in `generic`. */
	readonly useCases: readonly GenericUseCaseInfo[];
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
			{
				action: "update",
				rule: 'Saves a changed entity. For a "versioned" entity, only when the stored version is still the one it read (else RepositoryConcurrencyConflict, 409), and the version goes up by one.',
			},
			{ action: "delete", rule: "Destroys an entity (soft delete)." },
			{
				action: "restore",
				rule: 'Brings back a soft-deleted entity, by entity or id. Needs deletion "soft".',
			},
			{
				action: "increment",
				rule: 'Adds numbers to keys of the entity in one atomic write: increment(id, { views: 1 }, { create? }). Only number keys in its "change"; create gives the input of the entity to create when the id holds none. Bumps the version of a versioned entity. Needs a provider with atomic increment (inMemory and drizzle).',
			},
			{
				action: "count",
				rule: "Counts the entities; takes an optional query to count only the matching ones.",
			},
			{
				action: "findMany",
				rule: "Queries with { where?, orderBy?, limit?, offset? }. Needs no key.",
			},
			{
				action: "exists",
				rule: "Tells whether some entity matches a query (true or false). Needs no key.",
			},
			{
				action: "findPage",
				rule: "Gives { items, total, limit, offset } for a query (limit 20 by default). Needs no key.",
			},
			{
				action: "findCursor",
				rule: "Gives { items, limit, next } for { where?, orderBy?, limit?, after? }: pages by position, `after` being the `next` of the page before. No offset and no total. Needs no key, and a provider that reads by cursor (inMemory and drizzle do).",
			},
			{
				action: "forEachPage",
				rule: "forEachPage(query, fn, { until? }) runs fn on each page of a findCursor query and gives { done, next?, pages, items }; until (a Date, epoch ms or a function) is checked between pages, and next is the after to resume from. Called from TypeScript, not a step. Needs no key, and a provider that reads by cursor.",
			},
		],
		exceptionLayers: Object.values(core.ExceptionLayers),
		coreExceptions: exportsOf
			.filter(
				([name, value]) =>
					name !== "Exception" &&
					typeof value === "function" &&
					value.prototype instanceof core.Exception,
			)
			.map(([name]) => name)
			.sort(),
		stages: Object.entries(core.StdStages.stages)
			.map(([name, factory]) => ({
				name,
				kind: core.stageKindOf(factory) as "transform" | "sink",
				builtin: true as const,
			}))
			.sort((a, b) => (a.name < b.name ? -1 : 1)),
		policies: Object.keys(core.StdEventPolicies.policies)
			.sort()
			.map((name) => ({ name, builtin: true as const })),
		reservedDeclarationNames: [...Object.keys(core), "App", "Providers"].sort(),
		useCases: core.StdUseCases.list.map((plugin) => {
			const { name, version, description, requires } = plugin.toJSON();
			return {
				name,
				version,
				...(description === undefined ? {} : { description }),
				actions: requires.actions,
				plugins: requires.plugins,
				options: GENERIC_OPTIONS[name] ?? [],
			};
		}),
	};
}

/**
 * The options of each standard use case, which a plugin does not describe:
 * checked against the plugins themselves by the tests of the catalog.
 */
const GENERIC_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	create: ["as", "owner", "omit", "values"],
	get: ["as", "owner"],
	list: ["owner", "orderBy"],
	update: ["as", "owner"],
	delete: ["as", "owner"],
	restore: ["as"],
	publish: ["as", "owner", "set"],
	unpublish: ["as", "owner", "set"],
	archive: ["as", "owner", "set"],
	unarchive: ["as", "owner", "set"],
	tag: ["as", "owner"],
	untag: ["as", "owner"],
	register: ["as", "owner", "omit", "values"],
	login: ["as"],
};

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

/** The info of a standard use case by name. */
export function genericUseCase(name: string): GenericUseCaseInfo | undefined {
	return catalog().useCases.find((useCase) => useCase.name === name);
}

/** The info of a Std record plugin by name. */
export function recordPlugin(name: string): RecordPluginInfo | undefined {
	return catalog().recordPlugins.find((plugin) => plugin.name === name);
}
