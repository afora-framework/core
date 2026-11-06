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

/** A reference to a hand-written export: `"./db.ts#provider"`, relative to the output directory. */
export interface ImportRef {
	readonly import: string;
}

/** An option of a provider: any JSON value, with `{ "import": ... }` references in place of values. */
export type ProviderOptionSpec =
	| string
	| number
	| boolean
	| null
	| ImportRef
	| readonly ProviderOptionSpec[]
	| { readonly [key: string]: ProviderOptionSpec };

/**
 * A repository provider: the built-in `"inMemory"`, a catalog provider with
 * options (`{ "use": "drizzle", "options": { "db": { "import": "./db.ts#db" } } }`)
 * or an import of a provider created by hand (`{ "import": "./db.ts#provider" }`).
 */
export type ProviderSpec =
	| "inMemory"
	| {
			readonly use: string;
			readonly options?: { readonly [key: string]: ProviderOptionSpec };
	  }
	| ImportRef;

/** A provider of the catalog supplied to codegen: where the factory comes from. */
export interface ProviderCatalogEntry {
	/** The name `use` refers to. */
	readonly name: string;
	/** A package or a path relative to the output directory. */
	readonly module: string;
	/** The factory, called with the options object. */
	readonly export: string;
}

/** What codegen needs besides the spec. */
export interface CodegenOptions {
	/** External providers `use` may name; `inMemory` is built in. */
	readonly providers?: readonly ProviderCatalogEntry[];
}

export interface RepositorySpec {
	readonly entity: string;
	readonly actions: readonly string[];
	/** Its own provider; it uses the application's when omitted. */
	readonly provider?: ProviderSpec;
	/** Physical removal (default), or retained rows hidden by deletedAt. */
	readonly deletion?: "hard" | "soft";
	/** The repositories of the entities the entity holds. */
	readonly relations?: readonly string[];
	/** The environments it depends on. */
	readonly environments?: readonly string[];
}

/** A declared exception (`exceptionOf`). */
export interface ExceptionSpec {
	/** One of the `ExceptionLayers` values: `use-case`, `repository`, `command`, ... */
	readonly layer: string;
	/** `"<Name>."` when omitted. */
	readonly message?: string;
}

/** A blueprint by name, or declared in place. */
export type BlueprintRefSpec = string | { readonly fields: FieldsSpec };

/** A value of a step: a `$reference`, a JSON literal (`{ "literal": x }` escapes a `$`) or a mapping. */
export type StepValueSpec = unknown;

/** A core exception named in a step: `{ "core": "RepositoryUniqueViolation" }`. */
export interface CoreExceptionRef {
	readonly core: string;
}

/** One step of the DSL, as JSON: see `docs/plans/T15-design.md`. */
export type StepSpec =
	| {
			readonly find: string;
			readonly args?: readonly StepValueSpec[];
			readonly as?: string;
	  }
	| {
			readonly ensure: string;
			readonly value: StepValueSpec;
			readonly other?: StepValueSpec;
			readonly error: string | CoreExceptionRef;
			readonly details?: StepValueSpec;
	  }
	| {
			readonly build: string;
			readonly values: StepValueSpec;
			readonly as: string;
	  }
	| {
			readonly change: string;
			readonly key: string;
			readonly value: StepValueSpec;
			readonly as?: string;
	  }
	| {
			readonly invoke: string;
			readonly method: string;
			readonly args?: readonly StepValueSpec[];
			readonly as?: string;
	  }
	| {
			readonly create: string;
			readonly value: StepValueSpec;
			readonly as?: string;
	  }
	| {
			readonly update: string;
			readonly value: StepValueSpec;
			readonly as?: string;
	  }
	| {
			readonly delete: string;
			readonly value: StepValueSpec;
			readonly as?: string;
	  }
	| {
			readonly call: string;
			readonly input: StepValueSpec;
			readonly as?: string;
	  }
	| {
			readonly run: string;
			/** The function, imported as it is. */
			readonly fn: ImportRef;
			readonly args?: readonly StepValueSpec[];
			readonly as?: string;
	  }
	| { readonly return: StepValueSpec };

/** How a use case is implemented: the steps DSL, or a hand-written class. */
export type UseCaseImplementationSpec =
	| { readonly steps: readonly StepSpec[] }
	| ImportRef;

export interface UseCaseSpec {
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly deprecated?: boolean;
	readonly input: BlueprintRefSpec;
	readonly response: BlueprintRefSpec;
	readonly context?: BlueprintRefSpec;
	/** Key -> name of a use case, repository or environment. */
	readonly dependencies?: Readonly<Record<string, string>>;
	/** Declared exceptions or core exceptions (by class name) a caller should expect. */
	readonly errors?: readonly string[];
	readonly implementation: UseCaseImplementationSpec;
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
	/** The provider the repositories use unless they declare their own. */
	readonly provider?: ProviderSpec;
	readonly properties?: Readonly<Record<string, PropertySpec>>;
	readonly blueprints?: Readonly<Record<string, BlueprintSpec>>;
	readonly records?: Readonly<Record<string, RecordSpec>>;
	readonly entities?: Readonly<Record<string, RecordSpec>>;
	readonly environments?: Readonly<Record<string, EnvironmentSpec>>;
	readonly repositories?: Readonly<Record<string, RepositorySpec>>;
	readonly exceptions?: Readonly<Record<string, ExceptionSpec>>;
	readonly useCases?: Readonly<Record<string, UseCaseSpec>>;
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
	"exceptions",
	"useCases",
] as const;

export type CollectionKey = (typeof COLLECTIONS)[number];

export type DeclKind =
	| "property"
	| "blueprint"
	| "record"
	| "entity"
	| "environment"
	| "repository"
	| "exception"
	| "useCase";

export const KIND_OF: Readonly<Record<CollectionKey, DeclKind>> = {
	properties: "property",
	blueprints: "blueprint",
	records: "record",
	entities: "entity",
	environments: "environment",
	repositories: "repository",
	exceptions: "exception",
	useCases: "useCase",
};

export const DEFAULT_OUTPUT_DIR = "src/domain";
