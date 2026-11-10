import type { BlueprintField } from "../../blueprint/types/blueprint.interface";
import type {
	AnyRepository,
	AnyRepositoryEntity,
	EntityInstanceOf,
} from "../../repository/types/repository.interface";
import type { Kind } from "../../symbols/kind";
import type { AnyUseCaseClass, UseCaseStepsSettings } from "../use-case";

/** What a use case plugin needs of the repository it is made for. */
export interface UseCasePluginRequirements {
	/** The actions the repository must declare, e.g. `["findById", "update"]`. */
	readonly actions?: readonly string[];
	/** The record plugins the entity must have, by name. */
	readonly plugins?: readonly string[];
}

/** What a key of the entity is, for a use case that reads or writes it. */
export interface UseCaseFieldPlan {
	readonly key: string;
	readonly field: BlueprintField;
	/** One of the identity keys: `id`, `createdAt`, `updatedAt`, `deletedAt`. */
	readonly identity: boolean;
	/** The record plugin that adds the key, by name. */
	readonly plugin: string | undefined;
	readonly sensitive: boolean;
	readonly unique: boolean;
	readonly optional: boolean;
	/** Whether the entity has `change.<key>`. */
	readonly change: boolean;
	readonly kind:
		| "property"
		| "blueprint"
		| "list"
		| "record"
		| "entity"
		| "entity-list";
	/** The entity class the key holds, for `entity` and `entity-list`. */
	readonly related: AnyRepositoryEntity | undefined;
	/**
	 * What an input takes for the key: `<key>Id` and the `id` field of the
	 * entity it holds, for an entity; else the key and the field, as they are.
	 */
	readonly input: { readonly key: string; readonly field: BlueprintField };
}

/** What `compile` gets of the repository a use case is made for. */
export interface UseCaseTargetInfo {
	readonly repository: AnyRepository;
	/** The name `repositoryOf` gave it. */
	readonly repositoryName: string;
	readonly entity: AnyRepositoryEntity;
	/** The declared name of the entity, else the name of its class. */
	readonly entityName: string;
	readonly actions: readonly string[];
	readonly deletion: "hard" | "soft";
	/** Every key of the entity, in the order of its blueprint. */
	readonly fields: readonly UseCaseFieldPlan[];
	readonly changeKeys: readonly string[];
	readonly uniqueKeys: readonly string[];
	/** The field plan of `key`; throws `UseCaseUnavailable` when the entity has no such key. */
	field(key: string): UseCaseFieldPlan;
	/**
	 * The repository of the entity the key holds, with the `actions` it must
	 * declare; throws `UseCaseUnavailable` when the repository has no such
	 * relation or the related one lacks an action.
	 */
	relation(key: string, actions?: readonly string[]): AnyRepository;
	/** Throws `UseCaseUnavailable` for this target, with `reason`. */
	unavailable(reason: string): never;
}

/**
 * The declaration a plugin compiles: what `useCaseOf` takes, with `steps`.
 * The steps are data here, checked by `useCaseOf` when the class is made.
 */
export interface UseCaseCompilation
	extends Omit<
		// biome-ignore lint/suspicious/noExplicitAny: the blueprints and dependencies of any use case
		UseCaseStepsSettings<any, any, any, any>,
		"steps"
	> {
	readonly steps: readonly Readonly<Record<string, unknown>>[];
}

/**
 * The call signature of a plugin without one of its own: any repository,
 * any options.
 */
export type UseCaseMaker = (
	// biome-ignore lint/suspicious/noExplicitAny: any repository
	repository: any,
	// biome-ignore lint/suspicious/noExplicitAny: the options of any plugin
	options?: any,
) => AnyUseCaseClass;

/** What `useCasePluginOf` takes, after the name. */
export interface UseCasePluginSettings {
	/** A semantic version, e.g. `1.2.0`; `1.0.0` when left out. */
	readonly version?: string;
	/** What the use case does, for catalogs and tools. */
	readonly description?: string;
	readonly requires?: UseCasePluginRequirements;
	/**
	 * The use case for `target` and `options`, as the settings of
	 * `useCaseOf` with `steps`. The options are the plain object the caller
	 * gave, `{}` when none.
	 */
	compile(
		target: UseCaseTargetInfo,
		options: Readonly<Record<string, unknown>>,
	): UseCaseCompilation;
}

/** The plain, JSON form of a use case plugin, as `plugin.toJSON()` gives it. */
export interface UseCasePluginDescriptor {
	readonly kind: "use-case-plugin";
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	readonly requires: Required<UseCasePluginRequirements>;
}

/**
 * A use case that is made for a repository: its blueprints, dependencies and
 * steps follow the entity, the actions and the plugins. Made by
 * `useCasePluginOf`.
 */
export interface IUseCasePlugin<
	Name extends string = string,
	Make extends UseCaseMaker = UseCaseMaker,
> {
	readonly [Kind]: "use-case-plugin";
	readonly name: Name;
	readonly version: string;
	readonly description?: string;
	readonly requires: Required<UseCasePluginRequirements>;
	/**
	 * The use case class for a repository and options: the same class for
	 * the same repository and equal options. Throws `UseCaseUnavailable`
	 * when the repository or its entity lacks what the plugin requires.
	 */
	readonly make: Make;
	toJSON(): UseCasePluginDescriptor;
}

/** Any use case plugin. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugins
export type AnyUseCasePlugin = IUseCasePlugin<string, any>;

/** Where a use case class made by a plugin comes from, as `useCaseOriginOf` gives it. */
export interface UseCaseOriginInfo {
	readonly plugin: AnyUseCasePlugin;
	readonly repository: AnyRepository;
	readonly options: Readonly<Record<string, unknown>>;
}

/** @internal */
export type UseCasePluginsByName<Plugins extends readonly AnyUseCasePlugin[]> =
	{
		readonly [Plugin in Plugins[number] as Plugin["name"]]: Plugin;
	};

/** @internal The `make` of each plugin, by name. */
export type UseCaseContextOf<Plugins> = {
	readonly [Name in keyof Plugins]: Plugins[Name] extends {
		readonly make: infer Make;
	}
		? Make
		: never;
};

/**
 * Use case plugins by name: what `commandBuilderOf` gives `useCases` to pick
 * from, as `(ctx) => ({ create: ctx.create(Posts) })`. Made by
 * `useCaseCatalogOf`.
 */
export interface IUseCaseCatalog<
	Plugins extends Readonly<Record<string, AnyUseCasePlugin>> = Readonly<
		Record<string, AnyUseCasePlugin>
	>,
> {
	readonly [Kind]: "use-case-catalog";
	readonly plugins: Plugins;
	readonly list: readonly AnyUseCasePlugin[];
	/** The `make` of each plugin, by name. */
	readonly context: UseCaseContextOf<Plugins>;
	/** The plugin of a name, or of a name and a version (`create@1.0.0`). */
	resolve(reference: string): AnyUseCasePlugin;
}

/**
 * @internal The context of a list of catalogs: the `make` of every plugin,
 * a later catalog winning a name.
 */
export type UseCasePluginContext<Catalogs extends readonly IUseCaseCatalog[]> =
	Catalogs extends readonly [
		infer Head extends IUseCaseCatalog,
		...infer Tail extends readonly IUseCaseCatalog[],
	]
		? Omit<Head["context"], keyof UseCasePluginContext<Tail>> &
				UseCasePluginContext<Tail>
		: Record<never, never>;

type ActionsOf<Repository> = Repository extends {
	readonly actions: readonly (infer Action)[];
}
	? Action
	: never;

/** The entity class of a repository. */
export type EntityOfRepository<Repository> = Repository extends {
	readonly entity: infer Entity;
}
	? Entity
	: never;

/** What the type of an argument shows when the repository lacks an action. */
export interface MissingRepositoryAction<Action extends string> {
	readonly "this use case needs the repository to declare the action": Action;
}

/** What the type of an argument shows when the entity lacks a record plugin. */
export interface MissingRecordPlugin<Plugin extends string> {
	readonly "this use case needs the entity to have the plugin": Plugin;
}

/**
 * The precondition of a use case plugin, in the type of its repository
 * argument, written `repository: Repository & UseCaseTarget<Repository, ...>`:
 * nothing when `Repository` declares every `Action` and its entities have
 * the `Members` of the record plugin `Plugin`; else the type that names what
 * is missing.
 */
export type UseCaseTarget<
	Repository,
	Action extends string,
	Members = unknown,
	Plugin extends string = never,
> = [Action] extends [ActionsOf<Repository>]
	? EntityInstanceOf<EntityOfRepository<Repository>> extends Members
		? unknown
		: MissingRecordPlugin<Plugin>
	: MissingRepositoryAction<Exclude<Action, ActionsOf<Repository>>>;
