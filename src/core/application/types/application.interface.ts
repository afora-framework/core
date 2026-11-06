import type { AnyEnvironment } from "../../environment/environment";
import type { RecordPluginDescriptor } from "../../record/types/plugin.interface";
import type {
	AnyRepository,
	IRepositoryProvider,
} from "../../repository/types/repository.interface";
import type { Kind } from "../../symbols/kind";

type Named<Value> = Readonly<Record<string, Value>>;

/** The declarations of an application, by name, one collection for each kind. */
export interface ApplicationCollections {
	readonly properties: Named<unknown>;
	readonly blueprints: Named<unknown>;
	readonly records: Named<unknown>;
	readonly entities: Named<unknown>;
	readonly environments: Named<AnyEnvironment>;
	readonly repositories: Named<AnyRepository>;
}

/**
 * The keys of `ApplicationCollections`.
 * @internal
 */
export type ApplicationCollectionKey = keyof ApplicationCollections;

/** What `applicationOf` takes. */
export interface ApplicationSettings<
	Name extends string,
	Extended extends readonly AnyApplication[],
	Collections extends ApplicationCollections,
> {
	/** The name of the application; the `from` of each declaration it registers. */
	readonly name: Name;
	/** Applications whose declarations it inherits, which stay usable alone. */
	readonly extends?: Extended;
	readonly properties?: Collections["properties"];
	readonly blueprints?: Collections["blueprints"];
	readonly records?: Collections["records"];
	readonly entities?: Collections["entities"];
	readonly environments?: Collections["environments"];
	readonly repositories?: Collections["repositories"];
	/**
	 * The provider of the repositories that did not declare one; the
	 * repositories of the application read and write through it.
	 */
	readonly provider?: IRepositoryProvider;
}

type UnionToIntersection<Union> = (
	Union extends unknown
		? (value: Union) => void
		: never
) extends (value: infer Intersection) => void
	? Intersection
	: never;

/**
 * `Own` with the declarations of `Extended` merged in.
 * @internal
 */
export type MergedCollections<
	Own extends ApplicationCollections,
	Extended extends readonly AnyApplication[],
> = {
	readonly [Key in ApplicationCollectionKey]: Own[Key] &
		UnionToIntersection<Extended[number][Key]>;
};

/** A named, immutable manifest of what an application declares. */
export interface IApplication<
	Name extends string,
	Collections extends ApplicationCollections,
> {
	readonly [Kind]: "application";
	readonly name: Name;
	/** The applications it extends directly. */
	readonly extends: readonly AnyApplication[];
	/** The default provider of its repositories, if any. */
	readonly provider: IRepositoryProvider | undefined;
	readonly properties: Collections["properties"];
	readonly blueprints: Collections["blueprints"];
	readonly records: Collections["records"];
	readonly entities: Collections["entities"];
	readonly environments: Collections["environments"];
	/**
	 * Its repositories, inherited ones included. With a `provider` they are
	 * bound to it: they share the declaration of the original but read and
	 * write through that provider (unless they declared their own).
	 */
	readonly repositories: Collections["repositories"];
	/** The bound version of a repository registered in the application. */
	repository<Repository extends AnyRepository>(
		repository: Repository,
	): Repository;
	/** A new application with the declarations of `others` too; this one is left as it is. */
	extend<const Others extends readonly AnyApplication[]>(
		...others: Others
	): IApplication<Name, MergedCollections<Collections, Others>>;
	/** A format-neutral, JSON-serializable graph of its declarations. */
	describe(): ApplicationDescription;
}

/** Any application. */
// biome-ignore lint/suspicious/noExplicitAny: any application, whatever it declares
export type AnyApplication = IApplication<string, any>;

/** How a property was made, as `describe` gives it. */
export type PropertyLineageDescription =
	| {
			readonly kind: "refined";
			readonly base: PropertyReference;
			readonly options: Readonly<Record<string, unknown>>;
	  }
	| { readonly kind: "optional"; readonly base: PropertyReference }
	| {
			readonly kind: "factory";
			readonly factory: string;
			readonly args: Readonly<Record<string, unknown>>;
	  };

/**
 * A property: its `name` (that of `propertyOf`, which identifies a root
 * property), its flags and JSON Schema, and `lineage` when it was refined,
 * made optional or made by a factory. A root property that is not in the
 * standard catalog can only be referenced, never recreated.
 */
export interface PropertyDescription {
	readonly name: string;
	readonly optional: boolean;
	readonly sensitive: boolean;
	readonly unique: boolean;
	readonly schema: Readonly<Record<string, unknown>>;
	readonly lineage?: PropertyLineageDescription;
}

/** A registered property by name, or described in full. */
export type PropertyReference = { readonly ref: string } | PropertyDescription;

/** What a key of a blueprint, record or environment holds. */
export type FieldDescription =
	| {
			readonly kind: "property";
			readonly ref: string;
			readonly optional: boolean;
	  }
	| ({ readonly kind: "property" } & PropertyDescription)
	| {
			readonly kind: "list";
			readonly item: FieldDescription;
			readonly optional: boolean;
			readonly minItems?: number;
			readonly maxItems?: number;
	  }
	| {
			readonly kind: "blueprint";
			readonly ref: string;
			readonly optional: boolean;
	  }
	| {
			readonly kind: "blueprint";
			readonly optional: boolean;
			readonly fields: Readonly<Record<string, FieldDescription>>;
	  }
	| {
			readonly kind: "record" | "entity";
			readonly ref: string;
			readonly optional: boolean;
	  };

export type FieldsDescription = Readonly<Record<string, FieldDescription>>;

/** A record or an entity: its fields (an entity's identity and its plugins' keys left out), options and plugins. */
export interface RecordDescription {
	readonly from: string;
	readonly fields: FieldsDescription;
	readonly options: {
		readonly sensitive: readonly string[];
		readonly unique: readonly string[];
		readonly change: readonly string[];
	};
	readonly plugins: readonly RecordPluginDescriptor[];
}

/** The graph `describe` gives: every declaration by name, with its origin in `from`. */
export interface ApplicationDescription {
	readonly name: string;
	/** The names of the applications it extends directly. */
	readonly extends: readonly string[];
	readonly properties: Readonly<
		Record<string, PropertyDescription & { readonly from: string }>
	>;
	readonly blueprints: Readonly<
		Record<
			string,
			{ readonly from: string; readonly fields: FieldsDescription }
		>
	>;
	readonly records: Readonly<Record<string, RecordDescription>>;
	readonly entities: Readonly<Record<string, RecordDescription>>;
	readonly environments: Readonly<
		Record<
			string,
			{ readonly from: string; readonly fields: FieldsDescription }
		>
	>;
	readonly repositories: Readonly<
		Record<
			string,
			{
				readonly from: string;
				readonly entity: string;
				readonly actions: readonly string[];
				/** The names of the repositories of the entities its entity holds. */
				readonly relations: readonly string[];
				/** The names of its `environmentDependencies`. */
				readonly environments: readonly string[];
				/** Whether it declared a provider of its own. */
				readonly provider: boolean;
			}
		>
	>;
}
