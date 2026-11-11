import { isBlueprint } from "../blueprint/is-blueprint";
import type { IBlueprintCollection } from "../blueprint/types/blueprint.interface";
import type { EntityEvent } from "../entity/event";
import {
	type AnyEnvironment,
	type EnvironmentDependencies,
	isEnvironment,
	loadEnvironments,
} from "../environment/environment";
import { resolvePublisher } from "../event-policy/publishers";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { guard } from "../exception/guard";
import {
	clock,
	elapsed,
	type ILogger,
	logFailure,
	resolveLogger,
	silentLogger,
	writeLog,
} from "../logger/logger";
import { isRepository } from "../repository/repository";
import { findState, type RepositoryState } from "../repository/state";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import {
	endSpan,
	failSpan,
	type ITracer,
	type ITraceSpan,
	resolveTracer,
	runInSpan,
	startSpan,
} from "../tracing/tracing";
import { isUseCaseCatalog } from "../use-case/plugin-catalog";
import { type ExecutionScope, ScopeKey } from "../use-case/scope";
import type {
	IUseCaseCatalog,
	UseCasePluginContext,
} from "../use-case/types/plugin.interface";
import { type AnyUseCaseClass, isUseCaseClass } from "../use-case/use-case";
import {
	CommandEventFailed,
	InvalidCommandContext,
	InvalidCommandDeclaration,
	InvalidCommandEnvironment,
	UnknownCommandOperation,
} from "./exceptions";
import type {
	AnyCommand,
	CommandBuilder,
	CommandBuilderSettings,
	CommandEventErrorHandler,
	CommandEventInfo,
	CommandEvents,
	CommandExecution,
	CommandOf,
	CommandSettings,
	CommandUseCases,
} from "./types/command.interface";

/** The check of the providers of each command, run on its first call or by `verifyCommand`. */
const verifiers = new WeakMap<object, () => unknown>();

/**
 * Checks now that the repositories of `command` share a provider that has
 * `transaction`, as its first call would; an application calls it when it
 * binds the command to its provider.
 * @internal
 */
export function verifyCommand(command: object): void {
	verifiers.get(command)?.();
}

/**
 * The provider whose transaction runs the calls of `command`, or `undefined`
 * without a transaction or a repository.
 * @internal
 */
export function commandTransactionProvider(
	command: object,
): IRepositoryProvider | undefined {
	return verifiers.get(command)?.() as IRepositoryProvider | undefined;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The providers of every repository the use cases reach, with the names of
 * the repositories. With `declared`, only the providers the repositories
 * declared: the others are bound later by an application.
 */
function repositoryProvidersOf(
	useCases: CommandUseCases,
	declared: boolean,
): Map<IRepositoryProvider, string[]> {
	const providers = new Map<IRepositoryProvider, string[]>();
	const seen = new Set<unknown>();
	const add = (state: RepositoryState) => {
		if (declared && !state.explicitProvider) return;
		const { provider, name } = state;
		const names = providers.get(provider) ?? [];
		if (!names.includes(name)) names.push(name);
		providers.set(provider, names);
	};
	const visit = (UseCase: AnyUseCaseClass): void => {
		if (seen.has(UseCase)) return;
		seen.add(UseCase);
		for (const dependency of Object.values(UseCase.dependencies)) {
			if (isUseCaseClass(dependency)) {
				visit(dependency);
			} else if (isRepository(dependency)) {
				const state = findState(dependency);
				if (!state) continue;
				add(state);
				for (const related of state.relations.values()) add(related);
			}
		}
	};
	for (const UseCase of Object.values(useCases)) visit(UseCase);
	return providers;
}

/**
 * The provider whose transaction runs a call, or `undefined` when no
 * repository is reachable. Throws if the repositories do not share one that
 * has `transaction`.
 */
function transactionProviderOf(
	name: string,
	useCases: CommandUseCases,
	declared = false,
): IRepositoryProvider | undefined {
	const providers = repositoryProvidersOf(useCases, declared);
	const invalid = (reason: string, repositories: readonly string[]): never => {
		throw new InvalidCommandDeclaration({
			source: name,
			details: { reason, repositories } as { reason: string },
		});
	};
	if (providers.size > 1) {
		const repositories = [...providers.values()].flat();
		invalid(
			`A transaction needs every repository to share one provider; found ${providers.size} (${repositories.join(", ")}).`,
			repositories,
		);
	}
	const [entry] = providers;
	if (!entry) return undefined;
	const [provider, repositories] = entry;
	if (
		typeof provider.transaction !== "function" ||
		provider.capabilities?.transactions === false
	) {
		invalid(
			`The provider of ${repositories.join(", ")} does not support transactions.`,
			repositories,
		);
	}
	return provider;
}

/** The keys of `UseCase.context` picked from the validated context of the command. */
function narrowed(
	UseCase: AnyUseCaseClass,
	context: unknown,
): object | undefined {
	if (!UseCase.context || typeof context !== "object" || context === null) {
		return undefined;
	}
	const picked: Record<string, unknown> = {};
	for (const key of Object.keys(UseCase.context.properties)) {
		if (Object.hasOwn(context, key)) {
			picked[key] = (context as Record<string, unknown>)[key];
		}
	}
	return picked;
}

/** What the `env` of a call gives: the variables of each environment, and all merged. */
interface CallEnvironment {
	readonly byEnvironment: ReadonlyMap<
		object,
		Readonly<Record<string, unknown>>
	>;
	readonly merged: Readonly<Record<string, unknown>>;
}

/**
 * The variables of each of `environments` with `given` over them, validated
 * by its blueprint. An environment whose every key is given is not loaded.
 */
function callEnvironment(
	source: string,
	environments: readonly AnyEnvironment[],
	given: unknown,
): CallEnvironment {
	if (typeof given !== "object" || given === null || Array.isArray(given)) {
		throw new InvalidCommandEnvironment({
			source,
			details: { keys: [], issues: [] },
		});
	}
	const values = given as Record<string, unknown>;
	const unknownKeys = Object.keys(values).filter(
		(key) =>
			!environments.some((environment) =>
				Object.hasOwn(environment.blueprint.properties, key),
			),
	);
	if (unknownKeys.length > 0) {
		throw new InvalidCommandEnvironment({
			source,
			details: { keys: unknownKeys, issues: [] },
		});
	}
	const byEnvironment = new Map<object, Readonly<Record<string, unknown>>>();
	const merged: Record<string, unknown> = {};
	for (const environment of environments) {
		const keys = Object.keys(environment.blueprint.properties);
		const picked: Record<string, unknown> = {};
		for (const key of keys) {
			if (Object.hasOwn(values, key)) picked[key] = values[key];
		}
		const complete = keys.every((key) => Object.hasOwn(picked, key));
		const base =
			Object.keys(picked).length === 0 || !complete ? environment.load() : {};
		if (Object.keys(picked).length === 0) {
			Object.assign(merged, base);
			continue;
		}
		const parsed = environment.blueprint.safeParse({ ...base, ...picked });
		if (parsed.issues) {
			throw new InvalidCommandEnvironment({
				source,
				details: {
					keys: [
						...new Set(
							parsed.issues.map((issue) => String(issue.path[0] ?? "")),
						),
					],
					issues: parsed.issues,
				},
				cause: parsed.issues.find((issue) => issue.cause)?.cause,
			});
		}
		const value = Object.freeze(parsed.value as Record<string, unknown>);
		byEnvironment.set(environment, value);
		Object.assign(merged, value);
	}
	return { byEnvironment, merged: Object.freeze(merged) };
}

/**
 * Declares a command: `settings.useCases` is the object of use case classes,
 * or a function of `generics`, the context of the catalogs, that gives it.
 */
function declareCommand<
	const UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
	Environment extends EnvironmentDependencies | undefined = undefined,
>(
	given: CommandBuilderSettings<UseCases, Context, Environment, never>,
	generics: object,
): CommandOf<UseCases, Context, Environment> {
	const { name, description, context, onEventError } = given;
	const source = typeof name === "string" ? name : "commandOf";
	// A use case plugin that cannot make its use case throws its own
	// exception, which gains the frame of the command.
	const picked: unknown = given.useCases;
	const useCases = (
		typeof picked === "function" && !isUseCaseClass(picked)
			? guard({ layer: ExceptionLayers.Command, source }, () =>
					(picked as (ctx: object) => unknown)(generics),
				)
			: picked
	) as UseCases;
	const settings = given as unknown as CommandSettings<
		UseCases,
		Context,
		Environment
	>;
	const invalid = (reason: string): never => {
		throw new InvalidCommandDeclaration({ source, details: { reason } });
	};
	if (typeof name !== "string" || !name.trim()) {
		invalid("Expected name to be a non-empty string.");
	}
	if (description !== undefined && typeof description !== "string") {
		invalid("Expected description to be a string.");
	}
	const tags = settings.tags === undefined ? [] : settings.tags;
	if (
		!Array.isArray(tags) ||
		tags.some((tag) => typeof tag !== "string") ||
		new Set(tags).size !== tags.length
	) {
		invalid("Expected tags to be distinct strings.");
	}
	if (context !== undefined && (!isBlueprint(context) || context.optional)) {
		invalid("Expected context to be a non-optional blueprint.");
	}
	if (
		typeof useCases !== "object" ||
		useCases === null ||
		Array.isArray(useCases) ||
		Reflect.ownKeys(useCases).length === 0
	) {
		invalid(
			"Expected useCases to be a non-empty object of use case classes, or a function returning one.",
		);
	}
	for (const key of Reflect.ownKeys(useCases)) {
		if (
			typeof key !== "string" ||
			!IDENTIFIER.test(key) ||
			!isUseCaseClass((useCases as Record<string, unknown>)[key])
		) {
			invalid(
				"Expected the operations to be identifiers holding use case classes.",
			);
		}
	}
	const transaction =
		settings.transaction === undefined ? false : settings.transaction;
	if (typeof transaction !== "boolean") {
		invalid("Expected transaction to be a boolean.");
	}
	const declaredEnvironments: unknown = settings.environmentDependencies;
	const environments: readonly AnyEnvironment[] = Object.freeze(
		declaredEnvironments === undefined
			? []
			: isEnvironment(declaredEnvironments)
				? [declaredEnvironments]
				: Array.isArray(declaredEnvironments)
					? [...declaredEnvironments]
					: [null as never],
	);
	if (
		!environments.every(isEnvironment) ||
		new Set(environments).size !== environments.length
	) {
		invalid(
			"Expected environmentDependencies to be distinct environments made by environmentOf.",
		);
	}
	const events: CommandEvents =
		settings.events === undefined ? "after-commit" : settings.events;
	if (
		events !== "after-commit" &&
		events !== "manual" &&
		typeof events !== "function"
	) {
		invalid('Expected events to be "after-commit", "manual" or a function.');
	}
	if (onEventError !== undefined) {
		if (typeof onEventError !== "function") {
			invalid("Expected onEventError to be a function.");
		}
		if (events !== "after-commit") {
			invalid('onEventError only applies to the "after-commit" policy.');
		}
	}
	// At declaration only the providers the repositories declared are checked:
	// an application binds the others to its provider later. All of them are
	// checked on the first call, or when an application binds the command.
	if (transaction) transactionProviderOf(source, useCases, true);
	let resolved: { provider: IRepositoryProvider | undefined } | undefined;
	const providerOfCall = (): IRepositoryProvider | undefined => {
		if (!transaction) return undefined;
		resolved ??= { provider: transactionProviderOf(source, useCases) };
		return resolved.provider;
	};
	const operations = Object.freeze(Object.keys(useCases));
	const frozenUseCases = Object.freeze({ ...useCases });

	/**
	 * Steps 1 to 5: validates, runs (in a transaction if declared) and drains
	 * the events. With a tracer, the span of the call starts before the
	 * validation; `keepSpan` leaves it open on success for `run`, which ends it
	 * after the policy.
	 */
	const perform = async (
		op: string,
		input: unknown,
		options: { context?: unknown; env?: unknown } | undefined,
		keepSpan: boolean,
	): Promise<{
		value: unknown;
		events: EntityEvent[];
		context: unknown;
		env: () => Readonly<Record<string, unknown>>;
		logger: ILogger;
		tracer: ITracer | undefined;
		span: ITraceSpan | undefined;
	}> => {
		if (typeof op !== "string" || !Object.hasOwn(frozenUseCases, op)) {
			throw new UnknownCommandOperation({
				source,
				details: { operation: String(op) },
			});
		}
		const where = `${source}.${op}`;
		const UseCase = frozenUseCases[op] as AnyUseCaseClass;
		// The tracer of the application that bound the use case: the span of
		// the call is the parent of the span of the use case, which its scope
		// carries. It starts before the checks, so that their failures show.
		const tracer = resolveTracer(undefined, UseCase);
		const span =
			tracer === undefined
				? undefined
				: startSpan(
						tracer,
						`command ${where}`,
						{ "afora.command": where, "afora.operation": op },
						undefined,
					);
		let callContext: unknown = options?.context;
		let given: unknown = callContext;
		let overrides: ReturnType<typeof callEnvironment> | undefined;
		try {
			if (context) {
				const checked = context.safeParse(callContext);
				if (checked.issues) {
					throw new InvalidCommandContext({
						source: where,
						details: { issues: checked.issues },
						cause: checked.issues.find((issue) => issue.cause)?.cause,
					});
				}
				callContext = checked.value;
				given = narrowed(UseCase, callContext);
			}
			overrides =
				options?.env === undefined
					? undefined
					: callEnvironment(where, environments, options.env);
		} catch (error) {
			failSpan(span, error, ExceptionLayers.Command);
			throw error;
		}
		// The application that bound the use case logs the call, and every use
		// case it runs, bound or not, gets its logger through the scope.
		const logger = resolveLogger(undefined, UseCase);
		const withEnvironments = (
			scope: ExecutionScope | undefined,
		): ExecutionScope | undefined => {
			const environmentsOfCall =
				overrides === undefined || overrides.byEnvironment.size === 0
					? scope?.environments
					: overrides.byEnvironment;
			if (!environmentsOfCall && !logger && !tracer) return scope;
			return {
				...scope,
				providers: scope?.providers ?? new Map(),
				...(environmentsOfCall ? { environments: environmentsOfCall } : {}),
				...(logger ? { logger } : {}),
				...(tracer ? { tracer, ...(span ? { span } : {}) } : {}),
			};
		};
		const run = async (declared: ExecutionScope | undefined) => {
			const scope = withEnvironments(declared);
			const useCase = new UseCase(input, { context: given, [ScopeKey]: scope });
			const value = await useCase.execute();
			return { value, events: useCase.pullEvents() };
		};
		const provider = providerOfCall();
		const started = clock();
		const outcome = await guard(
			{ layer: ExceptionLayers.Command, source: where },
			span === undefined || tracer === undefined
				? () =>
						provider?.transaction
							? provider.transaction((scoped) =>
									run({ providers: new Map([[provider, scoped]]) }),
								)
							: run(undefined)
				: () =>
						runInSpan(tracer, span, () =>
							provider?.transaction
								? provider.transaction((scoped) =>
										run({ providers: new Map([[provider, scoped]]) }),
									)
								: run(undefined),
						),
		).catch((error: unknown) => {
			// Logged once: a use case that failed inside has logged it already.
			logFailure(
				logger,
				"command-failed",
				{ command: where, ms: elapsed(started) },
				error,
			);
			failSpan(span, error, ExceptionLayers.Command);
			throw error;
		});
		writeLog(logger, "debug", "command", {
			command: where,
			ms: elapsed(started),
		});
		if (!keepSpan) endSpan(span);
		return {
			...outcome,
			context: callContext,
			env: () => overrides?.merged ?? loadEnvironments(environments),
			logger: logger ?? silentLogger,
			tracer,
			span,
		};
	};

	const command = {
		[Kind]: "command",
		commandName: name,
		description,
		tags: Object.freeze([...tags]),
		context,
		useCases: frozenUseCases,
		transaction,
		environments,
		get env() {
			return loadEnvironments(environments);
		},
		events,
		onEventError,
		operations,
		async execute(
			op: string,
			input: unknown,
			options?: { context?: unknown; env?: unknown },
		) {
			const { value, events } = await perform(op, input, options, false);
			return { value, events } satisfies CommandExecution<unknown>;
		},
		async run(
			op: string,
			input: unknown,
			options?: { context?: unknown; env?: unknown },
		) {
			const {
				value,
				events: raised,
				context: callContext,
				env,
				logger,
				tracer,
				span,
			} = await perform(op, input, options, true);
			const call = {
				operation: op,
				raised,
				context: callContext,
				env,
				logger,
			};
			if (span === undefined || tracer === undefined) {
				await applyPolicy(
					command as unknown as AnyCommand,
					events,
					onEventError,
					call,
				);
				return value;
			}
			// The span of the call covers its policy: a handler or a publisher
			// that fails fails it, and what the policy runs nests in it when the
			// tracer has a current span (`withSpan`).
			try {
				await runInSpan(tracer, span, () =>
					applyPolicy(
						command as unknown as AnyCommand,
						events,
						onEventError,
						call,
					),
				);
			} catch (error) {
				failSpan(span, error, ExceptionLayers.Command);
				throw error;
			}
			endSpan(span);
			return value;
		},
	};
	Object.freeze(command);
	verifiers.set(command, providerOfCall);
	return command as unknown as CommandOf<UseCases, Context, Environment>;
}

/**
 * A `commandOf` whose `useCases` may be a function of the use case plugins
 * of `catalogs`, by name, a later catalog winning a name:
 * `useCases: (ctx) => ({ create: ctx.create(Posts), custom: MyUseCase })`.
 * Throws `InvalidCommandDeclaration` for what is not a catalog made by
 * `useCaseCatalogOf`.
 */
export function commandBuilderOf<
	const Catalogs extends readonly IUseCaseCatalog[] = [],
>(...catalogs: Catalogs): CommandBuilder<UseCasePluginContext<Catalogs>> {
	if (!catalogs.every(isUseCaseCatalog)) {
		throw new InvalidCommandDeclaration({
			source: "commandBuilderOf",
			details: {
				reason: "Expected catalogs made by useCaseCatalogOf.",
			},
		});
	}
	const generics = Object.freeze(
		Object.assign({}, ...catalogs.map((catalog) => catalog.context)),
	);
	return ((settings: never) =>
		declareCommand(settings, generics)) as unknown as CommandBuilder<
		UseCasePluginContext<Catalogs>
	>;
}

/**
 * Groups use cases under operation names and is the boundary of a call: the
 * context is validated once, a transaction can wrap the use case, and the
 * events it raised are handled by a policy once it succeeded.
 */
export const commandOf: CommandBuilder<Record<never, never>> =
	commandBuilderOf();

/** Step 6: what the command does with the events of a call that succeeded. */
async function applyPolicy(
	command: AnyCommand,
	policy: CommandEvents,
	onEventError: CommandEventErrorHandler | undefined,
	call: {
		readonly operation: string;
		readonly raised: readonly EntityEvent[];
		readonly context: unknown;
		readonly env: () => Readonly<Record<string, unknown>>;
		readonly logger: ILogger;
	},
): Promise<void> {
	const { operation, raised } = call;
	const source = `${command.commandName}.${operation}`;
	if (policy === "manual") return;
	// The variables are read only when a handler reads them.
	const info: CommandEventInfo = {
		command,
		operation,
		context: call.context,
		get env() {
			return call.env();
		},
		logger: call.logger,
		publisher: (name) => resolvePublisher(command, name, source),
	};
	if (typeof policy === "function") {
		try {
			await policy(raised, info);
		} catch (cause) {
			// A policy that says which event failed (such as `publishEvents`) is passed up as it is.
			if (cause instanceof Exception && cause.name === "CommandEventFailed") {
				throw cause;
			}
			throw new CommandEventFailed({
				source,
				cause,
				details: { operation, handled: 0, remaining: raised.length },
			});
		}
		return;
	}
	for (const [index, event] of raised.entries()) {
		try {
			await event.handle({ logger: call.logger });
		} catch (cause) {
			if (!onEventError) {
				throw new CommandEventFailed({
					source,
					cause,
					details: {
						operation,
						event: event.name,
						handled: index,
						remaining: raised.length - index - 1,
					},
				});
			}
			try {
				await onEventError(cause, event, info);
			} catch (failure) {
				throw new CommandEventFailed({
					source,
					cause: failure,
					details: {
						operation,
						event: event.name,
						handled: index,
						remaining: raised.length - index - 1,
					},
				});
			}
		}
	}
}

/** Whether `value` is a command made by `commandOf`. */
export function isCommand(value: unknown): value is AnyCommand {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "command"
	);
}
