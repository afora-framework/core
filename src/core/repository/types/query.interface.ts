import type {
	EntityInstanceOf,
	EntityKeyOf,
	EntityValueOf,
	IRepositoryProvider,
	QueryValueOf,
} from "./repository.interface";

type QueryKey<Entity> = unknown extends Entity ? string : EntityKeyOf<Entity>;
type QueryValue<Entity, Key extends string> = unknown extends Entity
	? unknown
	: Key extends keyof EntityValueOf<Entity>
		? QueryValueOf<EntityValueOf<Entity>[Key]>
		: unknown;

/** Equality, or membership in a list. Conditions on different keys are ANDed. */
export type RepositoryWhere<Entity = unknown> = {
	readonly [Key in QueryKey<Entity>]?:
		| QueryValue<Entity, Key>
		| { readonly in: readonly QueryValue<Entity, Key>[] };
};

/** Ordered lexicographically; ties retain provider order. Missing values sort first. */
export interface RepositoryOrder<Key extends string = string> {
	readonly key: Key;
	readonly direction?: "asc" | "desc";
}

/** The v2 query shared by providers and typed repository reads. */
export interface RepositoryQuery<Entity = unknown> {
	readonly where?: RepositoryWhere<Entity>;
	readonly orderBy?: readonly RepositoryOrder<QueryKey<Entity>>[];
	/** Nonnegative integer; zero returns an empty result. */
	readonly limit?: number;
	/** Nonnegative integer, applied before limit. */
	readonly offset?: number;
	/** Include destroyed rows; repository defaults depend on its deletion policy. */
	readonly withDeleted?: boolean;
}

/** A page and the unpaginated number of matching live (or explicitly included) rows. */
export interface RepositoryPage<Entity> {
	readonly items: readonly EntityInstanceOf<Entity>[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
}

export interface RepositoryFindMany<Entity> {
	findMany(
		query?: RepositoryQuery<Entity>,
	): Promise<EntityInstanceOf<Entity>[]>;
}

export interface RepositoryExists<Entity> {
	exists(query?: RepositoryQuery<Entity>): Promise<boolean>;
}

export interface RepositoryFindPage<Entity> {
	/** Defaults to limit 20 and offset 0. */
	findPage(query?: RepositoryQuery<Entity>): Promise<RepositoryPage<Entity>>;
}

/** JSON values retained in provider descriptors, including explicit import references. */
export type ProviderOption =
	| null
	| boolean
	| number
	| string
	| readonly ProviderOption[]
	| { readonly [key: string]: ProviderOption };
export type ProviderOptions = Readonly<Record<string, ProviderOption>>;

/** A named provider can be reconstructed; opaque providers require an import mapping. */
export type ProviderDescription =
	| {
			readonly kind: "provider";
			readonly name: string;
			readonly options: ProviderOptions;
	  }
	| { readonly kind: "opaque" };

/** Equality and `in` are mandatory; additional operators are advertised here. */
export interface ProviderCapabilities {
	readonly operators?: readonly string[];
	readonly transactions?: boolean;
}

/** Declaration input for a named provider, implemented by providerOf in T10. */
export interface ProviderSettings<
	Options extends ProviderOptions = ProviderOptions,
	Provider extends IRepositoryProvider = IRepositoryProvider,
> {
	readonly name: string;
	readonly options?: Options;
	readonly create: (options: Options) => Provider;
}
