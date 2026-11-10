import type {
	BlueprintInput,
	IBlueprint,
	IBlueprintCollection,
} from "../../blueprint/types/blueprint.interface";
import type { EntityEvent } from "../../entity/event";
import type {
	AnyEnvironment,
	EnvironmentDependencies,
	MergedEnvironment,
} from "../../environment/environment";
import type { ILogger } from "../../logger/logger";
import type { Kind } from "../../symbols/kind";
import type {
	AnyUseCaseClass,
	UseCaseInput,
	UseCaseOptions,
	UseCaseResponse,
} from "../../use-case/use-case";

/** The use cases of a command, by operation name. */
export type CommandUseCases = Readonly<Record<string, AnyUseCaseClass>>;

/** What a handler policy gets next to the events. */
export interface CommandEventInfo {
	readonly command: AnyCommand;
	readonly operation: string;
	/** The context of the call, validated by the command's blueprint if it has one. */
	readonly context: unknown;
	/** The variables of the command's environments, with the `env` of the call over them. */
	readonly env: Readonly<Record<string, unknown>>;
	/**
	 * The logger of the application that bound the command, else the started
	 * application's; a logger that writes nothing without either.
	 */
	readonly logger: ILogger;
}

/** Handles all the events of a call, once it succeeded. */
export type CommandEventHandler = (
	events: readonly EntityEvent[],
	info: CommandEventInfo,
) => void | Promise<void>;

/**
 * What the command does with the events of a call, after it commits:
 * `"after-commit"` awaits `event.handle()` in order, `"manual"` leaves them
 * to `execute`, a function receives them all.
 */
export type CommandEvents = "after-commit" | "manual" | CommandEventHandler;

/** Called when an event fails with the `"after-commit"` policy; the next event still runs. */
export type CommandEventErrorHandler = (
	error: unknown,
	event: EntityEvent,
	info: CommandEventInfo,
) => void | Promise<void>;

export interface CommandSettings<
	UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
	Environment extends EnvironmentDependencies | undefined = undefined,
> {
	readonly name: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	/** What the caller supplies with each call; validated once by this blueprint. */
	readonly context?: IBlueprint<Exclude<Context, undefined>>;
	readonly useCases: UseCases;
	/** Runs every call in a transaction of the provider of the repositories. Default `false`. */
	readonly transaction?: boolean;
	/**
	 * One environment, or a list merged in order: read on first use as
	 * `command.env`, given to the event handlers, and to the use cases that
	 * declare the same environment, with the `env` of a call over them.
	 */
	readonly environmentDependencies?: Environment;
	readonly events?: CommandEvents;
	readonly onEventError?: CommandEventErrorHandler;
}

/**
 * The `useCases` of a command made by a builder: the object, or a function
 * of the use case plugins of its catalogs that gives it.
 */
export type CommandUseCasesOption<UseCases extends CommandUseCases, Generics> =
	| UseCases
	| ((ctx: Generics) => UseCases);

/** `CommandSettings` with `useCases` as a builder takes it. */
export interface CommandBuilderSettings<
	UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined,
	Environment extends EnvironmentDependencies | undefined,
	Generics,
> extends Omit<CommandSettings<UseCases, Context, Environment>, "useCases"> {
	/**
	 * The use cases, by operation name; or a function that gets the use
	 * case plugins of the builder's catalogs, each called with a repository,
	 * and gives them: `(ctx) => ({ create: ctx.create(Posts) })`.
	 */
	readonly useCases: CommandUseCasesOption<UseCases, Generics>;
}

/**
 * What `commandBuilderOf` gives: `commandOf`, with the use case plugins
 * `Generics` to pick from.
 */
export type CommandBuilder<Generics> = <
	const UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
	Environment extends EnvironmentDependencies | undefined = undefined,
>(
	settings: CommandBuilderSettings<UseCases, Context, Environment, Generics>,
) => CommandOf<UseCases, Context, Environment>;

/** The names of the operations of a command. */
export type CommandOperation<Command extends { readonly useCases: object }> =
	keyof Command["useCases"] & string;

/** The input of an operation. */
export type CommandInput<
	Command extends { readonly useCases: CommandUseCases },
	Op extends CommandOperation<Command>,
> = UseCaseInput<Command["useCases"][Op]>;

/** The response of an operation. */
export type CommandResponse<
	Command extends { readonly useCases: CommandUseCases },
	Op extends CommandOperation<Command>,
> = UseCaseResponse<Command["useCases"][Op]>;

/**
 * The options of a call: `{ context }` of the command when it declares one,
 * otherwise those of the use case.
 */
export type CommandOptions<
	Class extends AnyUseCaseClass,
	Context extends IBlueprintCollection | undefined,
	Environment extends EnvironmentDependencies | undefined = undefined,
> = Context extends IBlueprintCollection
	? [
			options: {
				readonly context: BlueprintInput<Context>;
			} & CommandEnvOption<Environment>,
		]
	: Class["context"] extends IBlueprint<infer Properties>
		? [options: UseCaseOptions<Properties> & CommandEnvOption<Environment>]
		: Environment extends undefined
			? []
			: [options?: CommandEnvOption<Environment>];

/**
 * The `env` a call can give, when the command declares environments: some of
 * their variables, in place of the loaded ones for this call.
 */
export type CommandEnvOption<
	Environment extends EnvironmentDependencies | undefined,
> = Environment extends undefined
	? { readonly env?: undefined }
	: { readonly env?: Partial<MergedEnvironment<Environment>> };

/** What `execute` gives: the response and the events, with no policy applied. */
export interface CommandExecution<Value> {
	readonly value: Value;
	readonly events: EntityEvent[];
}

/** A command made by `commandOf`. */
export interface CommandOf<
	UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
	// Declared, so that TypeScript does not measure it on every command (costly).
	in out Environment extends EnvironmentDependencies | undefined = undefined,
> {
	readonly [Kind]: "command";
	readonly commandName: string;
	readonly description: string | undefined;
	readonly tags: readonly string[];
	readonly context: Context extends IBlueprintCollection
		? IBlueprint<Context>
		: undefined;
	readonly useCases: Readonly<UseCases>;
	readonly transaction: boolean;
	/** The environments of `environmentDependencies`, as a list. */
	readonly environments: readonly AnyEnvironment[];
	/** Their variables, merged; read and validated on first use (`InvalidEnvironment`). */
	readonly env: MergedEnvironment<Environment>;
	readonly events: CommandEvents;
	readonly onEventError: CommandEventErrorHandler | undefined;
	readonly operations: readonly (keyof UseCases & string)[];
	/** Runs `op` and applies the event policy; gives its response. */
	run<Op extends keyof UseCases & string>(
		op: Op,
		input: UseCaseInput<UseCases[Op]>,
		...options: CommandOptions<UseCases[Op], Context, Environment>
	): Promise<UseCaseResponse<UseCases[Op]>>;
	/** Runs `op` and gives the response and the events, without applying the policy. */
	execute<Op extends keyof UseCases & string>(
		op: Op,
		input: UseCaseInput<UseCases[Op]>,
		...options: CommandOptions<UseCases[Op], Context, Environment>
	): Promise<CommandExecution<UseCaseResponse<UseCases[Op]>>>;
}

/** Any command. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous commands
export type AnyCommand = CommandOf<any, any, any>;
