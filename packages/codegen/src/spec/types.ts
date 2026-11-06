/** A value an enum property accepts. */
export type EnumValue = string | number;

/** The options of `Property.with` / `ctx.<property>(options)`, as JSON. */
export type WithOptions = Readonly<Record<string, unknown>>;

/** Bounds of a list field. */
export interface ListBounds {
	readonly minItems?: number;
	readonly maxItems?: number;
}

interface FieldModifiers {
	/** The key may be absent. */
	readonly optional?: boolean;
	/** A list of the type; `true` is an unbounded list. */
	readonly list?: boolean | ListBounds;
}

/** A field naming a type: a Std property (`email`) or a declaration (`Age`, `Address`, `User`). */
export interface TypeField extends FieldModifiers {
	readonly type: string;
	readonly with?: WithOptions;
}

/** A field holding one of some values. */
export interface EnumField extends FieldModifiers {
	readonly enum: readonly EnumValue[];
	readonly name?: string;
	readonly default?: EnumValue;
}

/** A nested object, declared in place. */
export interface InlineField extends FieldModifiers {
	readonly fields: Readonly<Record<string, FieldSpec>>;
}

/**
 * A field: `"email"`, `"Age?"`, `"string[]"`, `"User[]?"`, or the object form.
 */
export type FieldSpec = string | TypeField | EnumField | InlineField;

export type FieldsSpec = Readonly<Record<string, FieldSpec>>;

/** A custom property: a Std/declared property with options, an enum, or an import. */
export type PropertySpec =
	| {
			readonly base: string;
			readonly with?: WithOptions;
			readonly optional?: boolean;
	  }
	| {
			readonly enum: readonly EnumValue[];
			readonly name?: string;
			readonly default?: EnumValue;
			readonly optional?: boolean;
	  }
	| {
			/** A property that cannot be recreated from JSON, imported as it is. */
			readonly opaque: true;
			/** The name it is exported under; the declared name by default. */
			readonly ref?: string;
			/** Where it is imported from, relative to the output directory. */
			readonly import: string;
	  };

export interface BlueprintSpec {
	readonly fields: FieldsSpec;
}

export interface RecordSpec {
	readonly fields: FieldsSpec;
	readonly sensitive?: readonly string[];
	readonly unique?: readonly string[];
	readonly change?: readonly string[];
	/** Names of the Std record plugins (`authenticatable`...). */
	readonly plugins?: readonly string[];
}

export interface EnvironmentSpec {
	readonly fields: FieldsSpec;
}

export interface RepositorySpec {
	readonly entity: string;
	readonly actions: readonly string[];
	/** Physical removal (default), or retained rows hidden by deletedAt. */
	readonly deletion?: "hard" | "soft";
	/** The repositories of the entities the entity holds. */
	readonly relations?: readonly string[];
	/** The environments it depends on. */
	readonly environments?: readonly string[];
}

/** The afora.json document. */
export interface Spec {
	readonly $schema?: string;
	readonly version: 1;
	/** The name of the generated application. */
	readonly name?: string;
	/** Other specs whose declarations this one uses: a relative path or a package. */
	readonly extends?: readonly string[];
	readonly output?: { readonly dir: string };
	readonly properties?: Readonly<Record<string, PropertySpec>>;
	readonly blueprints?: Readonly<Record<string, BlueprintSpec>>;
	readonly records?: Readonly<Record<string, RecordSpec>>;
	readonly entities?: Readonly<Record<string, RecordSpec>>;
	readonly environments?: Readonly<Record<string, EnvironmentSpec>>;
	readonly repositories?: Readonly<Record<string, RepositorySpec>>;
	/** Reserved: not supported in v1. */
	readonly useCases?: unknown;
}

/** A spec with the specs it extends, already loaded, by the reference it uses. */
export interface ResolvedSpec {
	readonly spec: Spec;
	readonly extends?: Readonly<Record<string, ResolvedSpec>>;
}

/** One problem found in a spec. */
export interface SpecIssue {
	/** Where, in the JSON: `["entities", "User", "fields", "age"]`. */
	readonly path: readonly (string | number)[];
	/** A stable, machine-readable code. */
	readonly code: string;
	/** What is wrong and how to fix it. */
	readonly message: string;
}

export const COLLECTIONS = [
	"properties",
	"blueprints",
	"records",
	"entities",
	"environments",
	"repositories",
] as const;

export type CollectionKey = (typeof COLLECTIONS)[number];

export type DeclKind =
	| "property"
	| "blueprint"
	| "record"
	| "entity"
	| "environment"
	| "repository";

export const KIND_OF: Readonly<Record<CollectionKey, DeclKind>> = {
	properties: "property",
	blueprints: "blueprint",
	records: "record",
	entities: "entity",
	environments: "environment",
	repositories: "repository",
};

export const DEFAULT_OUTPUT_DIR = "src/domain";
