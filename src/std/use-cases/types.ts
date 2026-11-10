import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyRecordClass,
	BlueprintField,
	IBlueprint,
	IBlueprintCollection,
	IBlueprintList,
	OptionalBlueprint,
	OptionalBlueprintList,
	OptionalRecord,
} from "../../core/blueprint/types/blueprint.interface";
import type { EntityIdentityKey } from "../../core/entity/types/entity.interface";
import type { OptionalProperty } from "../../core/property/types/optional-property.type";
import type { AnyPropertyConstructor } from "../../core/property/types/property-collection.type";
import type {
	AnyRepository,
	AnyRepositoryEntity,
	EntityInstanceOf,
} from "../../core/repository/types/repository.interface";
import type {
	IUseCasePlugin,
	UseCaseTarget,
} from "../../core/use-case/types/plugin.interface";
import type {
	AnyExceptionClass,
	StepsUseCaseConstructor,
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
}

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

/** The input of `create`: the keys of the entity, an entity it holds by `<key>Id`. */
type CreateInput<Repository, Options> = {
	readonly [Key in KeyOf<Repository> as Key extends LeftOut<Options>
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
> = StepsUseCaseConstructor<
	Input,
	EntityResponse<Repository, Options>,
	{ readonly repository: Repository },
	OwnerContext<Repository, Options>
>;

type ById<Repository> = { readonly id: IdField<Repository> };

/** `create`: for a repository with the `create` action. */
export type CreateMaker = <
	Repository extends AnyRepository,
	const Options extends StdCreateOptions<Repository> = None,
>(
	repository: Repository & UseCaseTarget<Repository, "create">,
	options?: Options,
) => EntityUseCase<Repository, Options, CreateInput<Repository, Options>>;

/** `get`: for a repository with `findById`. */
export type GetMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findById">,
	options?: Options,
) => EntityUseCase<Repository, Options, ById<Repository>>;

/** `list`: for a repository with `findPage`. */
export type ListMaker = <
	Repository extends AnyRepository,
	const Options extends StdListOptions<Repository> = None,
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
>(
	repository: Repository & UseCaseTarget<Repository, "findById" | "update">,
	options?: Options,
) => EntityUseCase<Repository, Options, UpdateInput<Repository>>;

/** `delete`: for a repository with `findById` and `delete`. */
export type DeleteMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
>(
	repository: Repository & UseCaseTarget<Repository, "findById" | "delete">,
	options?: Options,
) => EntityUseCase<Repository, Options, ById<Repository>>;

/** `restore`: for a repository with soft deletion and the `restore` action. */
export type RestoreMaker = <
	Repository extends AnyRepository,
	const Options extends StdUseCaseOptions & { readonly as?: string } = None,
>(
	repository: Repository & UseCaseTarget<Repository, "restore">,
	options?: Options,
) => StepsUseCaseConstructor<
	ById<Repository>,
	EntityResponse<Repository, Options>,
	{ readonly repository: Repository }
>;

/** `publish` and `unpublish`: for a publishable entity. */
export type PublishMaker = <
	Repository extends AnyRepository,
	const Options extends StdLifecycleOptions<Repository> = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ publish(at?: string): unknown; unpublish(): unknown },
			"publishable"
		>,
	options?: Options,
) => EntityUseCase<Repository, Options, ById<Repository>>;

/** `archive` and `unarchive`: for an archivable entity. */
export type ArchiveMaker = <
	Repository extends AnyRepository,
	const Options extends StdLifecycleOptions<Repository> = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ archive(at?: string): unknown; readonly isArchived: boolean },
			"archivable"
		>,
	options?: Options,
) => EntityUseCase<Repository, Options, ById<Repository>>;

/** `tag` and `untag`: for a taggable entity. */
export type TagMaker = <
	Repository extends AnyRepository,
	const Options extends StdEntityOptions<Repository> = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ tag(...tags: string[]): unknown; untag(...tags: string[]): unknown },
			"taggable"
		>,
	options?: Options,
) => EntityUseCase<
	Repository,
	Options,
	ById<Repository> & {
		readonly tags: IBlueprintList<typeof StringProperty>;
	}
>;

type Authenticatable = { verifyPassword(plain: string): Promise<boolean> };

/** `register`: for an authenticatable entity, with `findByEmail` and `create`. */
export type RegisterMaker = <
	Repository extends AnyRepository,
	const Options extends StdCreateOptions<Repository> = None,
>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findByEmail" | "create",
			Authenticatable,
			"authenticatable"
		>,
	options?: Options,
) => EntityUseCase<Repository, Options, CreateInput<Repository, Options>>;

/** `login`: for an authenticatable entity, with `findByEmail`. */
export type LoginMaker = <
	Repository extends AnyRepository,
	const Options extends StdUseCaseOptions & { readonly as?: string } = None,
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
	EntityResponse<Repository, Options>,
	{ readonly repository: Repository }
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
}

/** The plugins of `StdUseCases`, by name. */
export type StdUseCasePlugins = {
	readonly [Name in keyof StdUseCaseContext]: IUseCasePlugin<
		Name,
		StdUseCaseContext[Name]
	>;
};
