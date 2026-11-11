import type { DescribedJwtOptions } from "../../core/auth/types/jwt.interface";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyRecordClass,
	BlueprintField,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
	IBlueprintList,
	OptionalBlueprint,
	OptionalBlueprintList,
	OptionalRecord,
} from "../../core/blueprint/types/blueprint.interface";
import type { EntityIdentityKey } from "../../core/entity/types/entity.interface";
import type { EntityVersion } from "../../core/entity/version";
import type { OptionalProperty } from "../../core/property/types/optional-property.type";
import type { AnyPropertyConstructor } from "../../core/property/types/property-collection.type";
import type {
	AnyRepository,
	AnyRepositoryEntity,
	EntityInstanceOf,
} from "../../core/repository/types/repository.interface";
import type { AccessDeclaration } from "../../core/use-case/types/access.interface";
import type {
	IUseCasePlugin,
	UseCaseTarget,
} from "../../core/use-case/types/plugin.interface";
import type { RouteSettings } from "../../core/use-case/types/route.interface";
import type {
	AnyExceptionClass,
	DependencyFunctions,
	StepsUseCaseConstructor,
	UseCaseCollection,
} from "../../core/use-case/use-case";
import type { Integer, StringProperty } from "../properties/primitives";

type EntityOf<Repository> = Repository extends {
	readonly entity: infer Entity extends AnyRepositoryEntity;
}
	? Entity
	: never;

type PropertiesOf<Entity> = Entity extends {
	readonly blueprint: IBlueprint<infer Properties extends IBlueprintCollection>;
}
	? Properties
	: never;

type Props<Repository> = PropertiesOf<EntityOf<Repository>>;

type FieldAt<Properties, Key extends string> = Properties extends {
	readonly [Name in Key]: infer Field extends BlueprintField;
}
	? Field
	: never;

type IdField<Repository> = FieldAt<Props<Repository>, "id">;

type KeyOf<Repository> = keyof Props<Repository> & string;

/** Whether a field holds an entity, one that may be absent, or a list of them. */
type HoldsEntity<Field> = Field extends AnyRepositoryEntity
	? true
	: Field extends { readonly record: AnyRepositoryEntity }
		? true
		: Field extends IBlueprintList<infer Item>
			? Item extends AnyRepositoryEntity
				? true
				: false
			: false;

/** The field that accepts `undefined` too, as `optionalOf` gives it. */
type Optional<Field> = Field extends AnyPropertyConstructor
	? OptionalProperty<Field>
	: Field extends AnyBlueprintList
		? OptionalBlueprintList<Field>
		: Field extends AnyBlueprint
			? OptionalBlueprint<Field>
			: Field extends AnyRecordClass
				? OptionalRecord<Field>
				: never;

/** The errors a standard use case throws, in place of its defaults. */
export interface StdUseCaseErrors {
	/** For an entity that is not found, or is not the caller's. `UseCaseEntityNotFound` by default. */
	readonly notFound?: AnyExceptionClass;
	/** For an entity that already exists (`register`). `UseCaseEntityConflict` by default. */
	readonly conflict?: AnyExceptionClass;
	/** For credentials that do not match (`login`). `UseCaseInvalidCredentials` by default. */
	readonly invalid?: AnyExceptionClass;
	/** For a caller that is not found, when it owns what `create` makes. `notFound` by default. */
	readonly owner?: AnyExceptionClass;
}

/** The options every standard use case takes. */
export interface StdUseCaseOptions {
	/** The `useCaseName`; the verb and the name of the entity by default, as `CreatePost`. */
	readonly name?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly deprecated?: boolean;
	readonly errors?: StdUseCaseErrors;
	/** Where the use case is served over HTTP: the `route` of `useCaseOf`. */
	readonly route?: RouteSettings;
	/** Who may call it: the `access` of `useCaseOf`. */
	readonly access?: AccessDeclaration;
}

/**
 * The tokens `login` and `refresh` issue: the options of `jwtOf`, plus what
 * a token says of the entity. JSON, so it lives in an `afora.json`: the
 * secret is named by its environment variable (`{ env: "JWT_SECRET" }`).
 * Experimental: it may change in any release.
 */
export interface StdTokenOptions extends DescribedJwtOptions {
	/** Also issues a refresh token, which `refresh` exchanges; `expiresIn` is its life in seconds. */
	readonly refresh?: { readonly expiresIn: number };
	/** Scopes every token gets. */
	readonly scopes?: readonly string[];
	/** A key of the entity that holds a list of scopes, added to `scopes`. */
	readonly scopesFrom?: string;
	/** Claims of the token, each from a key of the entity: `{ tenant: "tenantId" }`. */
	readonly claims?: { readonly [claim: string]: string };
}

/** The response keys the `token` option adds. */
type TokenResponse<Options> = Options extends {
	readonly token: infer Token;
}
	? { readonly token: typeof StringProperty } & (Token extends {
			readonly refresh: object;
		}
			? { readonly refreshToken: typeof StringProperty }
			: unknown)
	: unknown;

/** Who owns the entities: the caller, whose id the context gives. */
export interface StdOwnerOption<Repository> {
	/**
	 * `key` holds the owner, as an id or as an entity (`ownerId` by default,
	 * the key of the `ownable` plugin), and `context` names the context key
	 * with the id of the caller: `create` fills the key from it, a use case
	 * over one entity throws `notFound` for another owner's, and `list` gives
	 * only the caller's.
	 */
	readonly owner?: {
		readonly key?: KeyOf<Repository>;
		readonly context: string;
	};
}

/** The options of a standard use case that gives one entity. */
export interface StdEntityOptions<Repository>
	extends StdUseCaseOptions,
		StdOwnerOption<Repository> {
	/** The key of the response that holds the entity; `item` by default. */
	readonly as?: string;
}

/** The options of `create` and `register`. */
export interface StdCreateOptions<Repository>
	extends StdEntityOptions<Repository> {
	/** Optional keys the input does not take. */
	readonly omit?: readonly KeyOf<Repository>[];
	/** Values the entity is built with, in place of taking them from the input. */
	readonly values?: { readonly [Key in KeyOf<Repository>]?: unknown };
}

/** The options of `publish`, `unpublish`, `archive` and `unarchive`. */
export interface StdLifecycleOptions<Repository>
	extends StdEntityOptions<Repository> {
	/** Change keys set before the entity is stored, e.g. `{ status: "published" }`. */
	readonly set?: { readonly [Key in KeyOf<Repository>]?: unknown };
}

/** The options of `list`. */
export interface StdListOptions<Repository>
	extends StdUseCaseOptions,
		StdOwnerOption<Repository> {
	/** The order of the page; newest first (`createdAt`, descending) by default. */
	readonly orderBy?: readonly {
		readonly key: KeyOf<Repository>;
		readonly direction?: "asc" | "desc";
	}[];
}

type None = Record<never, never>;

/** What `before` and `after` get of the call. */
export interface StdHookArgs<Input, Dependencies, Context> {
	/** The input of the call, parsed; for `after`, the one `before` gave back. */
	readonly input: Input;
	/**
	 * The dependencies of the call, as `execute` resolved them (overrides
	 * included): `repository`, those the use case makes to load what the
	 * input names, and those of the option `dependencies`.
	 */
	readonly dependencies: Dependencies;
	/** The context of the call: the id of the caller with `owner`, else `undefined`. */
	readonly context: Context;
}

/**
 * The options of a standard use case that writes: `before` runs before the
 * write and may give back the input to write in place of the one given;
 * `after` runs after it, within the transaction of the command; both get the
 * dependencies of the use case and those of `dependencies`, and `throws` adds
 * the exceptions they may throw to its errors (for `describe()` and statuses).
 */
export interface StdHookOptions<
	Input,
	Entity,
	Dependencies extends UseCaseCollection,
	Bound,
	Context,
	Loaded extends boolean,
> {
	/** Repositories, use cases or environments the hooks use, by name, beside those the use case makes. */
	readonly dependencies?: Dependencies;
	/**
	 * Runs before the write (after the entity is loaded and its owner
	 * checked, for a use case over one entity, which gets it as `entity`);
	 * what it gives back, if anything, is the input the use case goes on with.
	 */
	readonly before?: (
		args: StdHookArgs<Input, Bound, Context> &
			(Loaded extends true ? { readonly entity: Entity } : unknown),
		// biome-ignore lint/suspicious/noConfusingVoidType: a function that gives nothing back keeps the input
	) => Input | void | Promise<Input | void>;
	/** Runs after the write, with the entity written, before the response is given. */
	readonly after?: (
		args: StdHookArgs<Input, Bound, Context> & { readonly entity: Entity },
	) => unknown;
	/** Exceptions (made by `exceptionOf`) `before` or `after` may throw: added to the errors of the use case. */
	readonly throws?: readonly AnyExceptionClass[];
}

/** What `get`, `list` and `login` take in place of the hooks: none. */
export interface StdNoHookOptions {
	readonly before?: never;
	readonly after?: never;
	readonly dependencies?: never;
	readonly throws?: never;
}

type ContextValue<Repository, Options> =
	OwnerContext<Repository, Options> extends infer Context extends
		IBlueprintCollection
		? Readonly<BlueprintValue<Context>>
		: undefined;

/** `Options` as `Hookable` infers them. */
type Shape<Omitted, Values, Owner> = {
	readonly omit: readonly Omitted[];
	readonly values: Values;
} & ([Owner] extends [undefined] ? unknown : { readonly owner: Owner });

/** `StdHookOptions` for a use case over `Repository` that takes `Input`. */
type HookOptionsOf<
	Repository extends AnyRepository,
	Options,
	Input extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Loaded extends boolean,
> = StdHookOptions<
	BlueprintValue<Input>,
	EntityInstanceOf<EntityOf<Repository>>,
	Dependencies,
	DependencyFunctions<{ readonly repository: Repository } & Dependencies>,
	ContextValue<Repository, Options>,
	Loaded
>;

/**
 * The options of a use case that writes, as its maker reads them: those that
 * type its input and context, inferred one by one (`Options` is inferred from
 * the whole object only once the hooks are typed), and the hooks, typed by
 * them and not inferred from. The types of `before` and `after` are only
 * worked out for a call that gives them.
 */
interface Hookable<
	Repository extends AnyRepository,
	Input extends IBlueprintCollection,
	Omitted,
	Values,
	Owner,
	Dependencies extends UseCaseCollection,
	Loaded extends boolean,
> {
	readonly omit?: readonly Omitted[];
	readonly values?: Values;
	readonly owner?: Owner;
	readonly dependencies?: Dependencies;
	readonly throws?: readonly AnyExceptionClass[];
	readonly before?: NoInfer<
		HookOptionsOf<
			Repository,
			Shape<Omitted, Values, Owner>,
			Input,
			Dependencies,
			Loaded
		>["before"]
	>;
	readonly after?: NoInfer<
		HookOptionsOf<
			Repository,
			Shape<Omitted, Values, Owner>,
			Input,
			Dependencies,
			Loaded
		>["after"]
	>;
}

type AsOf<Options> = Options extends {
	readonly as: infer Key extends string;
}
	? Key
	: "item";

type EntityResponse<Repository, Options> = {
	readonly [Key in AsOf<Options>]: EntityOf<Repository>;
};

type OwnerContext<Repository, Options> = Options extends {
	readonly owner: { readonly context: infer Key extends string };
}
	? { readonly [Name in Key]: IdField<Repository> }
	: undefined;

type OwnerKey<Options> = Options extends { readonly owner: infer Owner }
	? Owner extends { readonly key: infer Key }
		? Key
		: "ownerId"
	: never;

type LeftOut<Options> =
	| EntityIdentityKey
	| OwnerKey<Options>
	| (Options extends { readonly omit: readonly (infer Key)[] } ? Key : never)
	| (Options extends { readonly values: infer Values } ? keyof Values : never);

/** `"version"` for a versioned entity, whose `version` is part of its identity. */
type VersionKey<Repository> =
	Props<Repository> extends {
		readonly version: typeof EntityVersion;
	}
		? "version"
		: never;

/** The input of `create`: the keys of the entity, an entity it holds by `<key>Id`. */
type CreateInput<Repository, Options> = {
	readonly [Key in KeyOf<Repository> as Key extends
		| LeftOut<Options>
		| VersionKey<Repository>
		? never
		: Props<Repository>[Key] extends AnyRepositoryEntity
			? `${Key}Id`
			: HoldsEntity<Props<Repository>[Key]> extends true
				? never
				: Key]: Props<Repository>[Key] extends AnyRepositoryEntity
		? FieldAt<PropertiesOf<Props<Repository>[Key]>, "id">
		: Props<Repository>[Key];
};

type ChangeKey<Repository> =
	EntityInstanceOf<EntityOf<Repository>> extends {
		readonly change: infer Changes;
	}
		? keyof Changes & KeyOf<Repository>
		: never;

/** The input of `update`: the id, and each change key, optional. */
type UpdateInput<Repository> = {
	readonly [Key in "id" | ChangeKey<Repository> as Key extends "id"
		? Key
		: HoldsEntity<Props<Repository>[Key]> extends true
			? never
			: Key]: Key extends "id"
		? IdField<Repository>
		: Optional<Props<Repository>[Key]>;
};

type EntityUseCase<
	Repository extends AnyRepository,
	Options,
	Input extends IBlueprintCollection,
	Dependencies extends UseCaseCollection = None,
> = StepsUseCaseConstructor<
	Input,
	EntityResponse<Repository, Options>,
	{ readonly repository: Repository } & Dependencies,
	OwnerContext<Repository, Options>
>;

type ById<Repository> = { readonly id: IdField<Repository> };

/** `create`: for a repository with the `create` action. */
export type CreateMaker = <
	Repository extends AnyRepository,
	const Options extends StdCreateOptions<Repository> = None,
	const Omitted extends KeyOf<Repository> = never,
	const Values = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository & UseCaseTarget<Repository, "create">,
	options?: Options &
		Hookable<
			Repository,
			CreateInput<Repository, Shape<Omitted, Values, Owner>>,
			Omitted,
			Values,
			Owner,
			Dependencies,
			false
		>,
) => EntityUseCase<
	Repository,
	Options,
	CreateInput<Repository, Options>,
	Dependencies
>;

/** `get`: for a repository with `findById`. */
export type GetMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> & StdNoHookOptions = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findById">,
	options?: Options,
) => EntityUseCase<Repository, Options, ById<Repository>>;

/** `list`: for a repository with `findPage`. */
export type ListMaker = <
	Repository extends AnyRepository,
	const Options extends StdListOptions<Repository> & StdNoHookOptions = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findPage">,
	options?: Options,
) => StepsUseCaseConstructor<
	{
		readonly limit: OptionalProperty<typeof Integer>;
		readonly offset: OptionalProperty<typeof Integer>;
	},
	{
		readonly items: IBlueprintList<EntityOf<Repository>>;
		readonly total: typeof Integer;
		readonly limit: typeof Integer;
		readonly offset: typeof Integer;
	},
	{ readonly repository: Repository },
	OwnerContext<Repository, Options>
>;

/** `update`: for a repository with `findById` and `update`. */
export type UpdateMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findById" | "update">,
	options?: Options &
		Hookable<
			Repository,
			UpdateInput<Repository>,
			never,
			None,
			Owner,
			Dependencies,
			true
		>,
) => EntityUseCase<Repository, Options, UpdateInput<Repository>, Dependencies>;

/** `delete`: for a repository with `findById` and `delete`. */
export type DeleteMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findById" | "delete">,
	options?: Options &
		Hookable<
			Repository,
			ById<Repository>,
			never,
			None,
			Owner,
			Dependencies,
			true
		>,
) => EntityUseCase<Repository, Options, ById<Repository>, Dependencies>;

/** `restore`: for a repository with soft deletion and the `restore` action. */
export type RestoreMaker = <
	Repository extends AnyRepository,
	const Options extends StdUseCaseOptions & {
		readonly as?: string;
	} = None,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository & UseCaseTarget<Repository, "restore">,
	options?: Options &
		Hookable<
			Repository,
			ById<Repository>,
			never,
			None,
			undefined,
			Dependencies,
			false
		>,
) => StepsUseCaseConstructor<
	ById<Repository>,
	EntityResponse<Repository, Options>,
	{ readonly repository: Repository } & Dependencies
>;

/** `publish` and `unpublish`: for a publishable entity. */
export type PublishMaker = <
	Repository extends AnyRepository,
	const Options extends StdLifecycleOptions<Repository> = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ publish(at?: string): unknown; unpublish(): unknown },
			"publishable"
		>,
	options?: Options &
		Hookable<
			Repository,
			ById<Repository>,
			never,
			None,
			Owner,
			Dependencies,
			true
		>,
) => EntityUseCase<Repository, Options, ById<Repository>, Dependencies>;

/** `archive` and `unarchive`: for an archivable entity. */
export type ArchiveMaker = <
	Repository extends AnyRepository,
	const Options extends StdLifecycleOptions<Repository> = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ archive(at?: string): unknown; readonly isArchived: boolean },
			"archivable"
		>,
	options?: Options &
		Hookable<
			Repository,
			ById<Repository>,
			never,
			None,
			Owner,
			Dependencies,
			true
		>,
) => EntityUseCase<Repository, Options, ById<Repository>, Dependencies>;

/** `tag` and `untag`: for a taggable entity. */
export type TagMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ tag(...tags: string[]): unknown; untag(...tags: string[]): unknown },
			"taggable"
		>,
	options?: Options &
		Hookable<
			Repository,
			TagInput<Repository>,
			never,
			None,
			Owner,
			Dependencies,
			true
		>,
) => EntityUseCase<Repository, Options, TagInput<Repository>, Dependencies>;

type TagInput<Repository> = ById<Repository> & {
	readonly tags: IBlueprintList<typeof StringProperty>;
};

type Authenticatable = { verifyPassword(plain: string): Promise<boolean> };

/** `register`: for an authenticatable entity, with `findByEmail` and `create`. */
export type RegisterMaker = <
	Repository extends AnyRepository,
	const Options extends StdCreateOptions<Repository> = None,
	const Omitted extends KeyOf<Repository> = never,
	const Values = None,
	const Owner = undefined,
	const Dependencies extends UseCaseCollection = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findByEmail" | "create",
			Authenticatable,
			"authenticatable"
		>,
	options?: Options &
		Hookable<
			Repository,
			CreateInput<Repository, Shape<Omitted, Values, Owner>>,
			Omitted,
			Values,
			Owner,
			Dependencies,
			false
		>,
) => EntityUseCase<
	Repository,
	Options,
	CreateInput<Repository, Options>,
	Dependencies
>;

/** `login`: for an authenticatable entity, with `findByEmail`. */
export type LoginMaker = <
	Repository extends AnyRepository,
	const Options extends StdUseCaseOptions & {
		readonly as?: string;
		/** Issues a token for the entity (and a refresh token, with `refresh`), in the response. */
		readonly token?: StdTokenOptions;
	} & StdNoHookOptions = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findByEmail",
			Authenticatable,
			"authenticatable"
		>,
	options?: Options,
) => StepsUseCaseConstructor<
	{
		readonly email: FieldAt<Props<Repository>, "email">;
		readonly password: typeof StringProperty;
	},
	EntityResponse<Repository, Options> & TokenResponse<Options>,
	{ readonly repository: Repository }
>;

/** `refresh`: exchanges a refresh token of `login` for new tokens; needs `findById`. */
export type RefreshMaker = <Repository extends AnyRepository>(
	repository: Repository & UseCaseTarget<Repository, "findById">,
	options: StdUseCaseOptions & {
		readonly token: StdTokenOptions & {
			readonly refresh: { readonly expiresIn: number };
		};
	} & StdNoHookOptions,
) => StepsUseCaseConstructor<
	{ readonly refreshToken: typeof StringProperty },
	{
		readonly token: typeof StringProperty;
		readonly refreshToken: typeof StringProperty;
	},
	{ readonly repository: Repository }
>;

/** `logout`: gives empty tokens, which a route with `setCookie` turns into removed cookies. */
export type LogoutMaker = <Repository extends AnyRepository>(
	repository: Repository,
	options?: StdUseCaseOptions & StdNoHookOptions,
) => StepsUseCaseConstructor<
	Record<never, never>,
	{
		readonly token: typeof StringProperty;
		readonly refreshToken: typeof StringProperty;
	},
	Record<never, never>
>;

/**
 * The standard use cases, by name: what the `useCases` of `commandOf` gets
 * to pick from, each called with a repository and its options.
 */
export interface StdUseCaseContext {
	readonly create: CreateMaker;
	readonly get: GetMaker;
	readonly list: ListMaker;
	readonly update: UpdateMaker;
	readonly delete: DeleteMaker;
	readonly restore: RestoreMaker;
	readonly publish: PublishMaker;
	readonly unpublish: PublishMaker;
	readonly archive: ArchiveMaker;
	readonly unarchive: ArchiveMaker;
	readonly tag: TagMaker;
	readonly untag: TagMaker;
	readonly register: RegisterMaker;
	readonly login: LoginMaker;
	readonly refresh: RefreshMaker;
	readonly logout: LogoutMaker;
}

/** The plugins of `StdUseCases`, by name. */
export type StdUseCasePlugins = {
	readonly [Name in keyof StdUseCaseContext]: IUseCasePlugin<
		Name,
		StdUseCaseContext[Name]
	>;
};
