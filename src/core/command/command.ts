import { isBlueprint } from "../blueprint/is-blueprint";
import type { IBlueprintCollection } from "../blueprint/types/blueprint.interface";
import type { EntityEvent } from "../entity/event";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { guard } from "../exception/guard";
import { isRepository } from "../repository/repository";
import { findState, type RepositoryState } from "../repository/state";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { type ExecutionScope, ScopeKey } from "../use-case/scope";
import { type AnyUseCaseClass, isUseCaseClass } from "../use-case/use-case";
import {
	CommandEventFailed,
	InvalidCommandContext,
	InvalidCommandDeclaration,
	UnknownCommandOperation,
} from "./exceptions";
import type {
	AnyCommand,
	CommandEventErrorHandler,
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

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The providers of every repository the use cases reach, with the names of
 * the repositories. With `declared`, only the providers the repositories
 * declared: the others are bound later by an application.
 */
function providersOf(
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
	const providers = providersOf(useCases, declared);
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

/**
 * Groups use cases under operation names and is the boundary of a call: the
 * context is validated once, a transaction can wrap the use case, and the
 * events it raised are handled by a policy once it succeeded.
 */
export function commandOf<
	const UseCases extends CommandUseCases,
	Context extends IBlueprintCollection | undefined = undefined,
>(settings: CommandSettings<UseCases, Context>): CommandOf<UseCases, Context> {
	const { name, description, context, useCases, onEventError } = settings;
	const source = typeof name === "string" ? name : "commandOf";
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
		invalid("Expected useCases to be a non-empty object of use case classes.");
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

	/** Steps 1 to 5: validates, runs (in a transaction if declared) and drains the events. */
	const perform = async (
		op: string,
		input: unknown,
		options: { context?: unknown } | undefined,
	): Promise<{
		value: unknown;
		events: EntityEvent[];
		context: unknown;
	}> => {
		if (typeof op !== "string" || !Object.hasOwn(frozenUseCases, op)) {
			throw new UnknownCommandOperation({
				source,
				details: { operation: String(op) },
			});
		}
		const where = `${source}.${op}`;
		const UseCase = frozenUseCases[op] as AnyUseCaseClass;
		let callContext: unknown = options?.context;
		let given: unknown = callContext;
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
		const run = async (scope: ExecutionScope | undefined) => {
			const useCase = new UseCase(input, { context: given, [ScopeKey]: scope });
			const value = await useCase.execute();
			return { value, events: useCase.pullEvents() };
		};
		const provider = providerOfCall();
		const outcome = await guard(
			{ layer: ExceptionLayers.Command, source: where },
			() =>
				provider?.transaction
					? provider.transaction((scoped) =>
							run({ providers: new Map([[provider, scoped]]) }),
						)
					: run(undefined),
		);
		return { ...outcome, context: callContext };
	};

	const command = {
		[Kind]: "command",
		commandName: name,
		description,
		tags: Object.freeze([...tags]),
		context,
		useCases: frozenUseCases,
		transaction,
		events,
		onEventError,
		operations,
		async execute(op: string, input: unknown, options?: { context?: unknown }) {
			const { value, events } = await perform(op, input, options);
			return { value, events } satisfies CommandExecution<unknown>;
		},
		async run(op: string, input: unknown, options?: { context?: unknown }) {
			const {
				value,
				events: raised,
				context: callContext,
			} = await perform(op, input, options);
			await applyPolicy(
				command as unknown as AnyCommand,
				events,
				onEventError,
				{
					operation: op,
					raised,
					context: callContext,
				},
			);
			return value;
		},
	};
	Object.freeze(command);
	verifiers.set(command, providerOfCall);
	return command as unknown as CommandOf<UseCases, Context>;
}

/** Step 6: what the command does with the events of a call that succeeded. */
async function applyPolicy(
	command: AnyCommand,
	policy: CommandEvents,
	onEventError: CommandEventErrorHandler | undefined,
	call: {
		readonly operation: string;
		readonly raised: readonly EntityEvent[];
		readonly context: unknown;
	},
): Promise<void> {
	const { operation, raised } = call;
	const source = `${command.commandName}.${operation}`;
	if (policy === "manual") return;
	if (typeof policy === "function") {
		try {
			await policy(raised, {
				command,
				operation,
				context: call.context,
			});
		} catch (cause) {
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
			await event.handle();
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
				await onEventError(cause, event);
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
