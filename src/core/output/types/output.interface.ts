import type { AnyBlueprint } from "../../blueprint/types/blueprint.interface";
import type { AnyCommand } from "../../command/types/command.interface";
import type { JsonValue } from "../../json";
import type { Kind } from "../../symbols/kind";
import type {
	AccessDeclaration,
	Principal,
} from "../../use-case/types/access.interface";
import type { RouteDeclaration } from "../../use-case/types/route.interface";
import type { AnyExceptionClass } from "../../use-case/use-case";

/** The options of a stage: a JSON object. */
export type StageOptions = { readonly [key: string]: JsonValue };

/** An HTTP-style status by exception name. */
export type OutputStatuses = Readonly<Record<string, number>>;

/**
 * The call of an operation: `context` is what the command (or use case)
 * declares, and `principal` is who calls, as the sink authenticated it
 * (`null` or absent for an anonymous caller). An operation with an `access`
 * checks the principal before it runs.
 */
export interface OperationCallOptions {
	readonly context?: unknown;
	readonly principal?: Principal | null;
}

/**
 * One operation of a command, as an output sees it. Frozen; transforms change
 * a copy with `operationOf`.
 */
export interface OperationDescriptor {
	readonly kind: "operation";
	readonly version: 1;
	/** `"Users.register"`. */
	readonly id: string;
	/** The name of the command. */
	readonly command: string;
	/** The operation name inside the command. */
	readonly name: string;
	/** The `useCaseName`. */
	readonly useCase: string;
	/** The use case description, else the command one. */
	readonly description?: string;
	/** The command tags, then the use case ones, deduplicated. */
	readonly tags: readonly string[];
	readonly deprecated: boolean;
	readonly input: AnyBlueprint;
	readonly response: AnyBlueprint;
	/** The command context, else the use case one. */
	readonly context?: AnyBlueprint;
	/** The `errors` of the use case. */
	readonly errors: readonly AnyExceptionClass[];
	/** The route the use case declares (`route` or `@Route`), if any. */
	readonly route?: RouteDeclaration;
	/** Who may call it, as the use case declares (`access` or `@Access`), if it does. */
	readonly access?: AccessDeclaration;
	/** Set by transforms; `{}` initially. */
	readonly meta: Readonly<Record<string, unknown>>;
	/**
	 * `command.run(name, input, { context })`, after the check of `access`:
	 * it rejects with `Unauthenticated` or `Forbidden` before anything runs.
	 */
	invoke(input: unknown, options?: OperationCallOptions): Promise<unknown>;
}

/** What `operationOf` can change. */
export interface OperationPatch {
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly tags?: readonly string[];
	readonly description?: string | undefined;
	readonly deprecated?: boolean;
	readonly invoke?: OperationDescriptor["invoke"];
}

/** What a stage knows about the output running it. */
export interface StageContext {
	readonly output: {
		readonly name: string;
		readonly statuses: OutputStatuses;
	};
}

/** A stage that changes (or removes, with `null`) each operation. */
export interface TransformStage<Options extends object = StageOptions> {
	readonly kind: "transform";
	readonly name?: string;
	readonly options?: Options;
	apply(
		operation: OperationDescriptor,
		context: StageContext,
	): OperationDescriptor | null;
}

/** The last stage: builds something concrete out of the operations. */
export interface SinkStage<
	Result = unknown,
	Options extends object = StageOptions,
> {
	readonly kind: "sink";
	readonly name?: string;
	readonly options?: Options;
	build(
		operations: readonly OperationDescriptor[],
		context: StageContext,
	): Result;
}

/** Any stage. */
// biome-ignore lint/suspicious/noExplicitAny: stages of any options and result
export type Stage = TransformStage<any> | SinkStage<any, any>;

// biome-ignore lint/suspicious/noExplicitAny: transforms of any options
type AnyTransform = TransformStage<any>;
// biome-ignore lint/suspicious/noExplicitAny: sinks of any options
type AnySink<Result> = SinkStage<Result, any>;

/** What a stage is, out of band: a name and JSON options, or opaque. */
export type StageDescription =
	| {
			readonly kind: "transform" | "sink";
			readonly name: string;
			readonly options: StageOptions;
	  }
	| { readonly kind: "opaque" };

/**
 * What `transformOf` takes: the `name` of the stage, the `apply` function that
 * changes each operation (or removes it) and an optional `validate` of its
 * options.
 */
export interface TransformSettings<Options extends object> {
	readonly name: string;
	/** Returns the operation, a changed copy, or `null` to remove it. */
	readonly apply: (
		operation: OperationDescriptor,
		options: Options,
		context: StageContext,
	) => OperationDescriptor | null;
	/** Why `options` cannot be used, or `undefined`. Checked when the stage is made. */
	readonly validate?: (options: Options) => string | undefined;
}

/**
 * What `sinkOf` takes: the `name` of the stage, the `build` function that turns
 * the operations into the result of the output (a server, a document...) and an
 * optional `validate` of its options.
 */
export interface SinkSettings<Result, Options extends object, Hooks = never> {
	readonly name: string;
	/**
	 * `hooks` is the second argument the stage was made with: what cannot be
	 * JSON (functions, an instance of a server). It is not part of the
	 * description of the stage.
	 */
	readonly build: (
		operations: readonly OperationDescriptor[],
		options: Options,
		context: StageContext,
		hooks: Hooks | undefined,
	) => Result;
	/** Why `options` cannot be used, or `undefined`. Checked when the stage is made. */
	readonly validate?: (options: Options) => string | undefined;
}

/** Makes a stage from JSON options. */
export type TransformFactory<Options extends object = StageOptions> = (
	options?: Options,
) => TransformStage<Options>;
/**
 * Makes a sink stage from JSON `options` and, second, `hooks`: what cannot be
 * JSON (functions, an instance of a server), which the description of the stage
 * leaves out. What `sinkOf` returns.
 */
export type SinkFactory<
	Result = unknown,
	Options extends object = StageOptions,
	Hooks = never,
> = (options?: Options, hooks?: Hooks) => SinkStage<Result, Options>;
/** Any stage factory. */
// biome-ignore lint/suspicious/noExplicitAny: factories of any options and result
export type StageFactory = TransformFactory<any> | SinkFactory<any, any>;

/** Stage factories by name. */
export interface IStageCatalog<
	Factories extends Readonly<Record<string, StageFactory>> = Readonly<
		Record<string, StageFactory>
	>,
> {
	readonly [Kind]: "stage-catalog";
	readonly stages: Factories;
	readonly list: readonly StageFactory[];
	/** Makes the stage `name` with `options`; throws `InvalidOutputStage` for an unknown name. */
	resolve(name: string, options?: StageOptions): Stage;
}

/** The result of the sink at the end of a pipe, or `never` when there is none. */
export type PipeResult<Pipe extends readonly Stage[]> = Pipe extends readonly [
	...Stage[],
	// biome-ignore lint/suspicious/noExplicitAny: any options
	SinkStage<infer Result, any>,
]
	? Result
	: never;

/** An application, as far as an output is concerned: it gives its commands. */
export interface OutputApplication {
	readonly [Kind]: "application";
	readonly commands: Readonly<Record<string, AnyCommand>>;
}

/** What an output takes its commands from. */
export type OutputSource = AnyCommand | OutputApplication;

/**
 * What `outputOf` takes: the `name` of the output, the `commands` it exposes
 * (commands, applications or a mix), the `statuses` by exception name and the
 * `pipe` of stages that transform its operations and end in a sink.
 */
export interface OutputSettings<Pipe extends readonly Stage[]> {
	readonly name: string;
	/** The commands the output exposes: commands, applications (all their commands) or a mix. */
	readonly commands: OutputApplication | readonly OutputSource[];
	/** HTTP-style status by exception name. */
	readonly statuses?: OutputStatuses;
	readonly pipe?: Pipe;
}

/** An output made by `outputOf`. */
export interface OutputOf<Result = never> {
	readonly [Kind]: "output";
	readonly outputName: string;
	readonly commands: readonly AnyCommand[];
	/** The operations after the transforms, in declaration order. */
	readonly operations: readonly OperationDescriptor[];
	readonly stages: readonly Stage[];
	readonly statuses: OutputStatuses;
	/** The result of the sink (memoized); throws when the pipe has no sink. */
	build(): Result;
	/** The result of the sink when the last stage is one, else a new, unnamed output. */
	pipe<Built>(...stages: [...AnyTransform[], AnySink<Built>]): Built;
	pipe(...stages: Stage[]): OutputOf<never>;
}

/** Any output. */
// biome-ignore lint/suspicious/noExplicitAny: outputs of any result
export type AnyOutput = OutputOf<any>;

/** An RFC 9457 problem. */
export interface Problem {
	readonly type: string;
	readonly title: string;
	readonly status: number;
	readonly detail: string;
	readonly layer?: string;
	/** Only for a 400 with validation issues. */
	readonly issues?: readonly {
		readonly path: readonly (string | number)[];
		readonly code: string;
		readonly message: string;
	}[];
	/** Only with `debug`. */
	readonly trace?: string;
}

/**
 * What `problemOf` takes: the HTTP `status` of the problem and `debug`, which
 * adds the `trace` and the real `detail` of a 5xx.
 */
export interface ProblemOptions {
	readonly status: number;
	readonly debug?: boolean;
}
