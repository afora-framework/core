import type {
	BlueprintInput,
	IBlueprint,
	IBlueprintCollection,
} from "../../blueprint/types/blueprint.interface";
import type { EntityEvent } from "../../entity/event";
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
) => void | Promise<void>;

export interface CommandSettings<
	UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
> {
	readonly name: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	/** What the caller supplies with each call; validated once by this blueprint. */
	readonly context?: IBlueprint<Exclude<Context, undefined>>;
	readonly useCases: UseCases;
	/** Runs every call in a transaction of the provider of the repositories. Default `false`. */
	readonly transaction?: boolean;
	readonly events?: CommandEvents;
	readonly onEventError?: CommandEventErrorHandler;
}

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
> = Context extends IBlueprintCollection
	? [options: { readonly context: BlueprintInput<Context> }]
	: Class["context"] extends IBlueprint<infer Properties>
		? [options: UseCaseOptions<Properties>]
		: [];

/** What `execute` gives: the response and the events, with no policy applied. */
export interface CommandExecution<Value> {
	readonly value: Value;
	readonly events: EntityEvent[];
}

/** A command made by `commandOf`. */
export interface CommandOf<
	UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
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
	readonly events: CommandEvents;
	readonly onEventError: CommandEventErrorHandler | undefined;
	readonly operations: readonly (keyof UseCases & string)[];
	/** Runs `op` and applies the event policy; gives its response. */
	run<Op extends keyof UseCases & string>(
		op: Op,
		input: UseCaseInput<UseCases[Op]>,
		...options: CommandOptions<UseCases[Op], Context>
	): Promise<UseCaseResponse<UseCases[Op]>>;
	/** Runs `op` and gives the response and the events, without applying the policy. */
	execute<Op extends keyof UseCases & string>(
		op: Op,
		input: UseCaseInput<UseCases[Op]>,
		...options: CommandOptions<UseCases[Op], Context>
	): Promise<CommandExecution<UseCaseResponse<UseCases[Op]>>>;
}

/** Any command. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous commands
export type AnyCommand = CommandOf<any, any>;
