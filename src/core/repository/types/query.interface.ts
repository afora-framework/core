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
	/**
	 * Include expired rows, of an entity declared with `expires`; `false` by
	 * default.
	 */
	readonly withExpired?: boolean;
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
 * previous page as `after` in place of `offset`. `where`, `orderBy`,
 * `withDeleted` and `withExpired` must stay the same from one page to the next.
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
 * What a provider gets. From `findCursor` on `findMany`, `after` holds one
 * value for each order of `orderBy`, those of the last row already read, and
 * the provider gives the rows strictly after it in that order; only a
 * provider with `capabilities.keyset` is given it. For an entity that expires
 * (`context.expiry`), `now` is the current date and time as an ISO 8601
 * string, from the clock of the entity: unless `withExpired`, the provider
 * leaves out the rows whose `context.expiry.key` is at or before it.
 */
export interface ProviderQuery extends RepositoryQuery {
	readonly after?: readonly unknown[];
	/** The current date and time (ISO 8601), given for entities that expire. */
	readonly now?: string;
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

/** Where `forEachPage` is in its walk, given with each page. */
export interface RepositoryWalkPage {
	/** The position of the page in this call, from 0. */
	readonly index: number;
	/**
	 * The cursor after this page, `undefined` on the last: save it once the
	 * page is done to resume from the next one.
	 */
	readonly next?: string;
}

/** When `forEachPage` stops before the end. */
export interface RepositoryWalkOptions {
	/**
	 * A deadline (a `Date` or epoch milliseconds) or a function that says when
	 * to stop; checked before each page, never while one runs.
	 */
	readonly until?: Date | number | (() => boolean);
}

/** What `forEachPage` did. */
export interface RepositoryWalkResult {
	/** Whether it walked to the last page; `false` when `until` stopped it. */
	readonly done: boolean;
	/**
	 * When it stopped early, the `after` to resume from: the `next` of the
	 * last page it ran, or the `after` it was given if it ran none.
	 */
	readonly next?: string;
	/** The pages it ran `fn` on. */
	readonly pages: number;
	/** The items of those pages. */
	readonly items: number;
}

export interface RepositoryForEachPage<Entity> {
	/**
	 * Reads the pages of `query` by cursor, as `findCursor` does, and runs
	 * `fn` on each, one after the other, until the last or until `until`
	 * says to stop (checked between pages). Rows added or removed between
	 * pages, by `fn` too, are neither repeated nor skipped. An error of `fn`
	 * stops the walk and rejects; resume from the last `next` saved.
	 */
	forEachPage(
		query: RepositoryCursorQuery<Entity>,
		fn: (
			items: EntityInstanceOf<Entity>[],
			page: RepositoryWalkPage,
		) => unknown,
		options?: RepositoryWalkOptions,
	): Promise<RepositoryWalkResult>;
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
	/** Whether `update` honors an expected `version` (versioned entities, #44). */
	readonly versioning?: boolean;
	/** Whether the provider has an atomic `increment` (#34). */
	readonly atomic?: boolean;
	/** Whether reads leave out expired records (entities with `expires`, #35). */
	readonly expiry?: boolean;
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
