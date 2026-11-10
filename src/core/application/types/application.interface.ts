import type {
	AnyBlueprint,
	BlueprintInput,
	IBlueprint,
} from "../../blueprint/types/blueprint.interface";
import type { AnyCommand } from "../../command/types/command.interface";
import type {
	AnyEnvironment,
	EnvironmentValue,
} from "../../environment/environment";
import type {
	EventPolicyDescription,
	IEventPublisher,
} from "../../event-policy/types/event-policy.interface";
import type { ExceptionLayers } from "../../exception/enums/exception-layers";
import type { ILogger, LogLevel, LogSettings } from "../../logger/logger";
import type {
	AnyOutput,
	StageDescription,
} from "../../output/types/output.interface";
import type { RecordPluginDescriptor } from "../../record/types/plugin.interface";
import type { ProviderDescription } from "../../repository/types/query.interface";
import type {
	AnyRepository,
	IRepositoryProvider,
} from "../../repository/types/repository.interface";
import type { Kind } from "../../symbols/kind";
import type { UseCaseStepDescription } from "../../use-case/steps/types/steps.interface";
import type {
	AnyExceptionClass,
	AnyUseCaseClass,
	UseCaseInput,
	UseCaseResponse,
} from "../../use-case/use-case";
import type { ProviderSlot, ProviderStorage } from "../providers";
import type { LogFactory, ProviderFactory } from "../start";

type Named<Value> = Readonly<Record<string, Value>>;

/**
 * The options of `app.run`: the `context` of the use case, required when it
 * declares one, and `dependencies`, what its `execute` takes to replace them.
 */
export type ApplicationRunOptions<UseCase extends AnyUseCaseClass> =
	(UseCase["context"] extends IBlueprint<infer Properties>
		? { readonly context: BlueprintInput<Properties> }
		: { readonly context?: undefined }) & {
		readonly dependencies?: Parameters<InstanceType<UseCase>["execute"]>[0];
	};

/**
 * What `app.run` takes after the use case: its input, optional when no key
 * of it is required, and the options, required when it declares a context.
 */
export type ApplicationRunArgs<UseCase extends AnyUseCaseClass> =
	UseCase["context"] extends AnyBlueprint
		? [input: UseCaseInput<UseCase>, options: ApplicationRunOptions<UseCase>]
		: // biome-ignore lint/complexity/noBannedTypes: whether every key is optional
			{} extends UseCaseInput<UseCase>
			? [
					input?: UseCaseInput<UseCase>,
					options?: ApplicationRunOptions<UseCase>,
				]
			: [
					input: UseCaseInput<UseCase>,
					options?: ApplicationRunOptions<UseCase>,
				];

/** The declarations of an application, by name, one collection for each kind. */
export interface ApplicationCollections {
	readonly properties: Named<unknown>;
	readonly blueprints: Named<unknown>;
	readonly records: Named<unknown>;
	readonly entities: Named<unknown>;
	readonly environments: Named<AnyEnvironment>;
	readonly repositories: Named<AnyRepository>;
	readonly useCases: Named<AnyUseCaseClass>;
	readonly commands: Named<AnyCommand>;
	readonly outputs: Named<AnyOutput>;
	readonly exceptions: Named<AnyExceptionClass>;
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
	/** Use cases, keyed by their `useCaseName`. */
	readonly useCases?: Collections["useCases"];
	/** Commands, keyed by their `commandName`; every use case of each must be in `useCases`. */
	readonly commands?: Collections["commands"];
	/** Outputs, keyed by their `outputName`; every command of each must be in `commands`. */
	readonly outputs?: Collections["outputs"];
	/** Exceptions made by `exceptionOf`, keyed by their `name`. */
	readonly exceptions?: Collections["exceptions"];
	/**
	 * The provider of the repositories that did not declare one; the
	 * repositories of the application read and write through it. With
	 * `providerFrom`, it is made by `app.start()` from the variables of its
	 * environments, and calls before that throw `ApplicationNotStarted`. A
	 * provider of `providers` (`Providers.main`) names the instance this
	 * application makes of it.
	 */
	readonly provider?: IRepositoryProvider | ProviderFactory;
	/**
	 * Named providers made by `providersOf`, which repositories name
	 * (`repositoryOf({ provider: Providers.audit })`). The application makes
	 * its own instance of each `providerFrom` on `start()` and binds the
	 * repositories to it; an application that extends it shares them.
	 */
	readonly providers?: ProviderStorage;
	/**
	 * How it logs: the providers its lines go to and the lowest level kept.
	 * Use cases, commands and repository calls of the application are logged
	 * through it, and a use case gets it as its `Logger` dependency. Without
	 * it, the one of the last extended application that has one; none by default.
	 */
	readonly log?: LogSettings | LogFactory;
	/**
	 * Where event policies such as `publishEvents` publish, by key: a
	 * WebSocket hub, a queue, a broker. Commands of the application find them
	 * by key, those of the extended applications included; a command whose
	 * policy names a key that is not here throws `UnregisteredApplicationReference`.
	 */
	readonly publishers?: Readonly<Record<string, IEventPublisher>>;
}

/**
 * What an application gives the factories it runs on start (`providerFrom`,
 * `logFrom`) and your code (`app.context`).
 */
export interface ApplicationContext {
	/** The name of the application. */
	readonly name: string;
	/**
	 * The variables of an environment registered in the application, typed by
	 * its blueprint; one that is not registered throws `UnregisteredApplicationReference`.
	 */
	env<Environment extends AnyEnvironment>(
		environment: Environment,
	): EnvironmentValue<Environment>;
	/** Its logger; a `log` of `logFrom` writes nothing before `start()`. */
	readonly logger: ILogger;
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
	/** Logs through the providers of its `log`; writes nothing without one. */
	readonly logger: ILogger;
	/** Its context: its name, the variables of its environments and its logger. */
	readonly context: ApplicationContext;
	readonly properties: Collections["properties"];
	readonly blueprints: Collections["blueprints"];
	readonly records: Collections["records"];
	readonly entities: Collections["entities"];
	readonly environments: Collections["environments"];
	/**
	 * Its repositories, inherited ones included. With a `provider` (or
	 * `providers`) they are bound to it: they share the declaration of the
	 * original but read and write through that provider (unless they declared
	 * their own).
	 */
	readonly repositories: Collections["repositories"];
	/**
	 * Its use cases. With a `provider`, `providers` or `log` they are
	 * subclasses whose repositories are the bound ones, through child use
	 * cases too; the same subclass every time. Without any of them they are
	 * the declared classes.
	 */
	readonly useCases: Collections["useCases"];
	/**
	 * Its commands. With a `provider`, `providers` or `log` they are rebuilt
	 * over the bound use cases (same settings), memoized; without any of them,
	 * the declared commands.
	 */
	readonly commands: Collections["commands"];
	/**
	 * Its outputs. With a `provider`, `providers` or `log` they are rebuilt
	 * over the bound commands (same name, statuses and stages), memoized;
	 * without any of them, the declared outputs.
	 */
	readonly outputs: Collections["outputs"];
	/** Its exceptions. */
	readonly exceptions: Collections["exceptions"];
	/** The bound version of a repository registered in the application. */
	repository<Repository extends AnyRepository>(
		repository: Repository,
	): Repository;
	/** The bound version of a use case registered in the application. */
	useCase<UseCase extends AnyUseCaseClass>(useCase: UseCase): UseCase;
	/**
	 * Runs a use case registered in the application over its bound
	 * repositories: `new (app.useCase(UseCase))(input, { context }).execute(dependencies)`.
	 * It rejects with what the constructor or `execute` throw. The events the
	 * use case collected are not handled; a command is what dispatches them.
	 */
	run<UseCase extends AnyUseCaseClass>(
		useCase: UseCase,
		...args: ApplicationRunArgs<UseCase>
	): Promise<UseCaseResponse<UseCase>>;
	/** The bound version of a command registered in the application. */
	command<Command extends AnyCommand>(command: Command): Command;
	/** The bound version of an output registered in the application. */
	output<Output extends AnyOutput>(output: Output): Output;
	/** A new application with the declarations of `others` too; this one is left as it is. */
	extend<const Others extends readonly AnyApplication[]>(
		...others: Others
	): IApplication<Name, MergedCollections<Collections, Others>>;
	/** A format-neutral, JSON-serializable graph of its declarations. */
	describe(): ApplicationDescription;
	/**
	 * Validates every environment it registers at once
	 * (`InvalidApplicationEnvironment`), makes the provider of `providerFrom`
	 * and checks the transactions of its commands against it. Idempotent: the
	 * same promise until it fails or `stop()` is called.
	 */
	start(
		options?: ApplicationStartOptions,
	): Promise<IApplication<Name, Collections>>;
	/**
	 * Closes its provider (`close`, if it has one); a provider of
	 * `providerFrom` is made again by the next `start()`. It stops being the
	 * started application of the process.
	 */
	stop(): Promise<void>;
	/** The variables of an environment registered in the application. */
	get<Environment extends AnyEnvironment>(
		environment: Environment,
	): EnvironmentValue<Environment>;
	/** The bound version of a command registered in the application. */
	get<Command extends AnyCommand>(command: Command): Command;
	/** The bound version of an output registered in the application. */
	get<Output extends AnyOutput>(output: Output): Output;
	/** The bound version of a use case registered in the application. */
	get<UseCase extends AnyUseCaseClass>(useCase: UseCase): UseCase;
	/** The bound version of a repository registered in the application. */
	get<Repository extends AnyRepository>(repository: Repository): Repository;
	/** The instance this application reads and writes through for a provider of its `providers`. */
	get(provider: ProviderSlot): IRepositoryProvider;
	/** Whether `start()` completed and `stop()` was not called since. */
	readonly started: boolean;
}

/** What `app.start()` takes. */
export interface ApplicationStartOptions {
	/**
	 * Become the started application of the process (what `useApplication()`
	 * gives). Default `true`; another one already started throws
	 * `ApplicationAlreadyStarted`.
	 */
	readonly register?: boolean;
	/** Stop the started application of the process and take its place, e.g. on hot reload. Default `false`. */
	readonly replace?: boolean;
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

/** What a use case depends on, by the name it has in the application. */
export interface UseCaseDependencyDescription {
	/** `logger` is the core's `Logger`, whose `ref` is always `"Logger"`. */
	readonly kind: "use-case" | "repository" | "environment" | "logger";
	readonly ref: string;
}

/** A use case: its metadata, fields and what it depends on. */
export interface UseCaseDescription {
	readonly from: string;
	/** The `useCaseName`, equal to its key. */
	readonly name: string;
	readonly description?: string;
	readonly tags: readonly string[];
	readonly deprecated: boolean;
	readonly input: FieldsDescription;
	readonly response: FieldsDescription;
	readonly context?: FieldsDescription;
	/**
	 * The names of the registered blueprints that are the `input`, `response`
	 * or `context` (their fields stay described above). Absent for the ones
	 * that are not registered.
	 */
	readonly refs?: {
		readonly input?: string;
		readonly response?: string;
		readonly context?: string;
	};
	/** A registered exception, or one exported by the package, by name. */
	readonly errors: readonly (
		| { readonly kind: "exception"; readonly ref: string }
		| { readonly kind: "core"; readonly name: string }
	)[];
	readonly dependencies: Readonly<Record<string, UseCaseDependencyDescription>>;
	/**
	 * How it runs: `steps` when `execute` is the interpreter of the declared
	 * steps, `opaque` for a hand-written `execute`.
	 */
	readonly implementation:
		| {
				readonly kind: "steps";
				readonly steps: readonly UseCaseStepDescription[];
		  }
		| { readonly kind: "opaque" };
	/**
	 * The use case plugin that made it, the registered repository it was made
	 * for and the options given, with classes by name as in the steps; absent
	 * for a use case declared by hand.
	 */
	readonly generic?: {
		readonly name: string;
		readonly version: string;
		readonly repository: string;
		readonly options: Readonly<Record<string, unknown>>;
	};
}

/** A command: its metadata, context, operations and policies. */
export interface CommandDescription {
	readonly from: string;
	readonly name: string;
	readonly description?: string;
	readonly tags: readonly string[];
	readonly context?: FieldsDescription;
	/** The name of the registered blueprint that is the `context`, if it is one. */
	readonly refs?: { readonly context?: string };
	/** Each operation and the name of its use case in the application. */
	readonly operations: Readonly<Record<string, { readonly ref: string }>>;
	readonly transaction: boolean;
	/** The names of its environments, when it declares any. */
	readonly environments?: readonly string[];
	/** The policy: a name, a policy made by `eventPolicyOf` by name and options, else opaque. */
	readonly events:
		| "after-commit"
		| "manual"
		| EventPolicyDescription
		| { readonly kind: "opaque" };
	readonly onEventError?: { readonly kind: "opaque" };
}

/** An output: its commands, statuses and pipe. */
export interface OutputDescription {
	readonly from: string;
	readonly name: string;
	readonly commands: readonly string[];
	readonly statuses: Readonly<Record<string, number>>;
	readonly pipe: readonly StageDescription[];
}

/** An exception: its layer and, when declared as a string, its message. */
export interface ExceptionDescription {
	readonly from: string;
	readonly layer: ExceptionLayers;
	readonly message?: string;
}

/** How `describe` gives the `log` of an application. */
export interface LogDescription {
	readonly level: LogLevel;
	/** The name of each provider made by `logProviderOf` with one; `opaque` otherwise (and for a `logFrom` before start). */
	readonly providers: readonly (
		| { readonly kind: "log-provider"; readonly name: string }
		| { readonly kind: "opaque" }
	)[];
}

/** How `describe` names a provider of `providersOf`: by its key. */
export interface ProviderReference {
	readonly kind: "ref";
	readonly key: string;
}

/** The graph `describe` gives: every declaration by name, with its origin in `from`. */
export interface ApplicationDescription {
	readonly name: string;
	/** The names of the applications it extends directly. */
	readonly extends: readonly string[];
	/** The provider of the application (or of the last extended one), present only when configured. */
	readonly provider?: ProviderDescription | ProviderReference;
	/** Its providers of `providersOf` (inherited ones included), by key; present only when it has some. */
	readonly providers?: Readonly<
		Record<string, ProviderDescription & { readonly from: string }>
	>;
	/** Its `log` (or the one of the last extended application), present only when configured. */
	readonly log?: LogDescription | { readonly kind: "opaque" };
	/** Its publishers (inherited ones included), by key, with the application that declared each; present only when it has some. */
	readonly publishers?: Readonly<Record<string, { readonly from: string }>>;
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
				readonly deletion: "hard" | "soft";
				/** The names of the repositories of the entities its entity holds. */
				readonly relations: readonly string[];
				/** The names of its `environmentDependencies`. */
				readonly environments: readonly string[];
				/** Its own provider, present only when it declared one; a provider of `providersOf` by its key. */
				readonly provider?: ProviderDescription | ProviderReference;
			}
		>
	>;
	readonly useCases: Readonly<Record<string, UseCaseDescription>>;
	readonly commands: Readonly<Record<string, CommandDescription>>;
	readonly outputs: Readonly<Record<string, OutputDescription>>;
	readonly exceptions: Readonly<Record<string, ExceptionDescription>>;
}
