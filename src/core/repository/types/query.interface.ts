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

/**
 * The query of `findCursor`: as `RepositoryQuery`, with the `next` of the
 * previous page as `after` in place of `offset`. `where`, `orderBy` and
 * `withDeleted` must stay the same from one page to the next.
 */
export interface RepositoryCursorQuery<Entity = unknown>
	extends Omit<RepositoryQuery<Entity>, "offset" | "limit"> {
	/** Positive integer; 20 when left out. */
	readonly limit?: number;
	/** The `next` of the page before; the first page when left out. */
	readonly after?: string;
}

/** A page read by position: its items and, when there are more, the cursor of the next. */
export interface RepositoryCursorPage<Entity> {
	readonly items: readonly EntityInstanceOf<Entity>[];
	readonly limit: number;
	/** What to give as `after` for the next page; `undefined` on the last one. */
	readonly next: string | undefined;
}

/**
 * What a provider gets from `findCursor` on `findMany`: `after` holds one
 * value for each order of `orderBy`, those of the last row already read, and
 * the provider gives the rows strictly after it in that order. Only a
 * provider with `capabilities.keyset` is given it.
 */
export interface ProviderQuery extends RepositoryQuery {
	readonly after?: readonly unknown[];
	/**
	 * The name of the declared index (`context.indexes`) that serves the
	 * query, when one does; a provider without `capabilities.indexes` can
	 * ignore it, and the rows must be the same either way.
	 */
	readonly index?: string;
}

/**
 * An access pattern a repository declares: queries whose `where` holds every
 * key of `where` by equality, and whose first order (if any) is `orderBy`.
 */
export interface RepositoryIndex<Key extends string = string> {
	/** The keys the query matches by equality, at least one. */
	readonly where: readonly Key[];
	/** The scalar key the rows are read in order of. */
	readonly orderBy?: Key;
}

/**
 * How a query reaches its rows: by `id`, by another unique key, through a
 * declared index (named by `index`), or by reading every row (`scan`).
 */
export interface RepositoryPlan {
	readonly access: "id" | "unique" | "index" | "scan";
	/** The declared index that serves the query, when `access` is `"index"`. */
	readonly index?: string;
}

/**
 * What a repository does with a query that only a scan serves: run it
 * (`"allow"`, the default), log `repository-scan` and run it (`"warn"`), or
 * throw `InvalidRepositoryQuery` before the provider is called (`"reject"`).
 */
export type RepositoryScans = "allow" | "warn" | "reject";

export interface RepositoryExplain<Entity> {
	/**
	 * How the query would be read (`{ access, index? }`), without reading
	 * anything; takes the query of `findMany` or of `findCursor`.
	 */
	explain(
		query?: RepositoryQuery<Entity> | RepositoryCursorQuery<Entity>,
	): Promise<RepositoryPlan>;
}

export interface RepositoryFindCursor<Entity> {
	/**
	 * A page of `limit` items (20 by default) after the cursor `after`. Unlike
	 * `findPage` it reads one page with one query, does not count, and stays
	 * correct when rows are added or removed between pages.
	 */
	findCursor(
		query?: RepositoryCursorQuery<Entity>,
	): Promise<RepositoryCursorPage<Entity>>;
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
	/** Whether `findMany` honors `after` (`ProviderQuery`), which `findCursor` needs. */
	readonly keyset?: boolean;
	/**
	 * Whether the provider serves the indexes a repository declares
	 * (`context.indexes`) from storage, reading `ProviderQuery.index`.
	 */
	readonly indexes?: boolean;
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
