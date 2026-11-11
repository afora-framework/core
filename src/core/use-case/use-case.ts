import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	BlueprintField,
	BlueprintInput,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isBlueprintVariant, variantOfValue } from "../blueprint/variant";
import { isEntity } from "../entity/entity";
import type { EntityEvent } from "../entity/event";
import {
	type AnyEnvironment,
	type EnvironmentValue,
	isEnvironment,
} from "../environment/environment";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import {
	type DeclaredExceptionClass,
	Exception,
	exceptionOf,
	isDeclaredException,
} from "../exception/exception";
import { guard } from "../exception/guard";
import {
	clock,
	elapsed,
	type ILogger,
	isLogger,
	isLoggerDeclaration,
	type LoggerDeclaration,
	logFailure,
	resolveLogger,
	silentLogger,
	writeLog,
} from "../logger/logger";
import type { Issue } from "../parse/types/parse.interface";
import { recordNameOf } from "../record/name";
import { AbstractRepository, isRepository } from "../repository/repository";
import type { AnyRepository } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { type ExecutionScope, ScopeKey } from "./scope";
import { freezeData } from "./steps/references";
import { executeSteps } from "./steps/run";
import type { CheckedSteps } from "./steps/types/check.interface";
import type { UseCaseStep } from "./steps/types/steps.interface";
import { validateSteps } from "./steps/validate";

/** A concrete UseCase declaration, usable as a dependency. */
export interface AnyUseCaseClass {
	readonly [Kind]: "use-case";
	readonly useCaseName: string;
	readonly blueprint: AnyBlueprint;
	readonly response: AnyBlueprint;
	readonly dependencies: UseCaseCollection;
	readonly context: AnyBlueprint | undefined;
	readonly description: string | undefined;
	readonly tags: readonly string[];
	readonly deprecated: boolean;
	readonly errors: readonly AnyExceptionClass[];
	new (
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous concrete UseCase constructors
		input: any,
		// biome-ignore lint/suspicious/noExplicitAny: with or without a context
		...options: any[]
	): {
		execute(): Promise<unknown>;
		pullEvents(): EntityEvent[];
	};
}

/** Any class made by `exceptionOf`. */
// biome-ignore lint/suspicious/noExplicitAny: exceptions with any details
export type AnyExceptionClass = DeclaredExceptionClass<any>;

/**
 * What a use case can depend on: another use case, a repository made by
 * `repositoryOf`, an environment made by `environmentOf`, or `Logger`.
 */
export type UseCaseDependency =
	| AnyUseCaseClass
	| AnyRepository
	| AnyEnvironment
	| LoggerDeclaration;

export type UseCaseCollection = Readonly<Record<string, UseCaseDependency>>;

type Declaration = {
	readonly blueprint: AnyBlueprint;
	readonly response: AnyBlueprint;
	readonly dependencies: UseCaseCollection;
};

export type UseCaseInput<Class extends Declaration> = BlueprintInput<
	Class["blueprint"]["properties"]
>;
export type UseCaseResponse<Class extends Declaration> = BlueprintValue<
	Class["response"]["properties"]
>;
export type UseCaseDependencies<Class extends Declaration> =
	DependencyFunctions<Class["dependencies"]>;
/** The context of a use case class, as `this.context` gives it; `undefined` without one. */
export type UseCaseContext<Class extends { readonly context: unknown }> =
	Class["context"] extends IBlueprint<infer Properties>
		? Readonly<BlueprintValue<Properties>>
		: undefined;

/**
 * The second argument of the constructor of a use case: `{ context }`,
 * required when the use case declares a context, not accepted otherwise.
 */
export type UseCaseOptions<
	Context extends IBlueprintCollection | undefined = undefined,
> = Context extends IBlueprintCollection
	? { readonly context: BlueprintInput<Context> }
	: { readonly context?: undefined };

/** @internal */
type OptionsArgs<Context extends IBlueprintCollection | undefined> =
	Context extends IBlueprintCollection
		? [options: UseCaseOptions<Context>]
		: [];

/**
 * What a use case gets for a dependency: a function for a use case, the
 * repository itself, the variables of an environment, or an `ILogger`.
 */
export type DependencyOf<Dependency> = Dependency extends AnyUseCaseClass
	? (input: UseCaseInput<Dependency>) => Promise<UseCaseResponse<Dependency>>
	: Dependency extends AnyEnvironment
		? EnvironmentValue<Dependency>
		: Dependency extends LoggerDeclaration
			? ILogger
			: Dependency;

export type DependencyFunctions<Dependencies extends UseCaseCollection> = {
	readonly [Key in keyof Dependencies]: DependencyOf<Dependencies[Key]>;
};

/**
 * What `execute` takes to replace dependencies: a function for a use case,
 * some of the methods of a repository, or the variables of an environment.
 */
export type DependencyOverrides<Dependencies extends UseCaseCollection> = {
	readonly [Key in keyof Dependencies]?: Dependencies[Key] extends AnyRepository
		? Partial<Dependencies[Key]>
		: DependencyOf<Dependencies[Key]>;
};

export interface UseCaseSettings<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined = undefined,
> {
	readonly name: string;
	readonly blueprint: IBlueprint<Input>;
	readonly response: IBlueprint<Output>;
	readonly dependencies?: Dependencies;
	/** What the caller supplies with each call, e.g. the user and the request; validated by this blueprint. */
	readonly context?: IBlueprint<Exclude<Context, undefined>>;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly deprecated?: boolean;
	/** The exceptions (made by `exceptionOf`) a caller should expect; documentation only. */
	readonly errors?: readonly AnyExceptionClass[];
}

/** `UseCaseSettings` with the `steps` that are its `execute`. */
export interface UseCaseStepsSettings<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined = undefined,
> extends UseCaseSettings<Input, Output, Dependencies, Context> {
	/**
	 * What the use case does, as data (see `UseCaseStep`): validated here,
	 * interpreted by its `execute`, and described by `describe()`.
	 */
	readonly steps: readonly UseCaseStep<NoInfer<Dependencies>>[];
	/** Checks the references and values of the steps at compile time (see `CheckedSteps`). */
	readonly strictSteps?: boolean;
}

/**
 * What `useCaseOf` takes: `UseCaseSettings`, and the `steps` that make the
 * class concrete, if any.
 */
export interface UseCaseDeclaration<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined = undefined,
	Steps extends readonly UseCaseStep<Dependencies>[] | undefined = undefined,
	Strict extends boolean = false,
> extends UseCaseSettings<Input, Output, Dependencies, Context> {
	/**
	 * What the use case does, as data (see `UseCaseStep`), which makes the
	 * class concrete: validated here, interpreted by its `execute`, and
	 * described by `describe()`. TypeScript checks the kinds of the steps and
	 * the names of dependencies and actions; with `strictSteps`, also their
	 * references and values (see `CheckedSteps`).
	 */
	readonly steps?: [Strict] extends [true]
		? CheckedSteps<
				Steps,
				NoInfer<Input>,
				NoInfer<Context>,
				NoInfer<Dependencies>
			>
		: Steps;
	/**
	 * `true` checks the steps, written inline, at compile time: each reference
	 * must name a value in scope (the input, the context, an environment or the
	 * result of an earlier step, at any depth), and the `args`, `values`,
	 * `value` and `input` of a step must fit what it calls or builds. It costs
	 * the editor more than the default checks. Without effect at run time.
	 */
	readonly strictSteps?: Strict;
}

export const InvalidUseCaseDeclaration = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidUseCaseDeclaration",
	message: ({ reason }: { reason: string }) => reason,
});
export const UseCaseAlreadyExecuted = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UseCaseAlreadyExecuted",
	message: "A UseCase instance can execute only once.",
});
export const InvalidUseCaseDependencies = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidUseCaseDependencies",
	message:
		"Dependency overrides must contain only declared names: functions for use cases, objects of methods for repositories, and valid variables for environments.",
});

interface RuntimeDeclaration extends Declaration {
	readonly useCaseName: string;
	readonly context: AnyBlueprint | undefined;
}
interface ExecutionState {
	readonly context: object | undefined;
	readonly scope: ExecutionScope | undefined;
	started: boolean;
	active: boolean;
	readonly events: EntityEvent[];
	readonly dependencies: Record<string, unknown>;
	resolved?: Record<string, unknown>;
	/** The class the use case was made from (bound by an application, maybe). */
	readonly owner: object;
}

/** The logger a call writes to, if any (see `resolveLogger`). */
function loggerOfCall(state: ExecutionState): ILogger | undefined {
	return resolveLogger(state.scope?.logger, state.owner);
}
const states = new WeakMap<object, ExecutionState>();

function invalidValue(
	issues: readonly Issue[],
	source: string,
	phase: string,
): never {
	throw new Exception({
		layer: ExceptionLayers.UseCase,
		name:
			phase === "input"
				? "InvalidUseCaseInput"
				: phase === "context"
					? "InvalidUseCaseContext"
					: "InvalidUseCaseResponse",
		source,
		message: `Invalid UseCase ${phase}.`,
		details: { issues },
		cause: issues.find((issue) => issue.cause)?.cause,
	});
}

/** Drains entities by their declared shape, without serialization or snapshots. */
function collectEvents(
	blueprint: AnyBlueprint,
	value: unknown,
	events: EntityEvent[],
): void {
	const visited = new WeakSet<object>();
	const visit = (field: BlueprintField, current: unknown): void => {
		if (typeof current !== "object" || current === null || visited.has(current))
			return;
		visited.add(current);
		if (isEntity(current)) events.push(...current.pullEvents());
		if (isBlueprintList(field)) {
			for (const item of current as unknown[]) visit(field.item, item);
			return;
		}
		// A variant is walked by the class of the record it holds, or by the
		// blueprint its key names.
		const shape = isBlueprint(field)
			? field
			: isBlueprintVariant(field)
				? isRecordClass(current.constructor)
					? current.constructor.blueprint
					: variantOfValue(field, current)
				: recordFieldOf(field)?.record.blueprint;
		if (!shape) return;
		for (const [key, child] of Object.entries(shape.properties)) {
			visit(child as BlueprintField, (current as Record<string, unknown>)[key]);
		}
	};
	visit(blueprint, value);
}

/**
 * Every entity of the class `Entity` in `value`, or in the list it is, at its
 * first level; the others are not the business of the repository.
 */
function pullEntities(
	value: unknown,
	Entity: abstract new (...args: never[]) => object,
	events: EntityEvent[],
): void {
	for (const item of Array.isArray(value) ? value : [value]) {
		if (isEntity(item) && item instanceof Entity) {
			events.push(...item.pullEvents());
		}
	}
}

/** The names of the public methods of `repository`, its own and those of its classes. */
function methodNamesOf(repository: object): string[] {
	const names = new Set<string>();
	for (
		let current: object | null = repository;
		current !== null &&
		current !== AbstractRepository.prototype &&
		current !== Object.prototype;
		current = Object.getPrototypeOf(current)
	) {
		for (const name of Object.getOwnPropertyNames(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (name !== "constructor" && typeof descriptor?.value === "function") {
				names.add(name);
			}
		}
	}
	return [...names];
}

/**
 * The methods of `repository`, with those of `overrides` in their place, that
 * run only while the use case executes, and hand the events of the entities
 * of the repository they take and give to it. The methods of the repository
 * run with a view of it as `this`, so that what they call on `this` (and the
 * overrides) goes through the same methods; the events of each call go up
 * once, as every call drains the entities it handles. The methods of
 * `overrides` run with `overrides` as `this`.
 */
function bindRepository(
	repository: AnyRepository,
	overrides: object | undefined,
	state: ExecutionState,
	source: string,
): object {
	const Entity = repository.entity;
	const repositoryName = recordNameOf(Entity);
	const bound: Record<string, unknown> = Object.create(null);
	// What the methods of the repository get as `this`: the bound methods, and the
	// repository for the rest, as the receiver, so that its getters see the view.
	const view: object = new Proxy(Object.create(repository), {
		get: (_target, key, receiver) => {
			if (typeof key === "string" && Object.hasOwn(bound, key)) {
				return bound[key];
			}
			if (key === ScopeKey) return state.scope;
			const value = Reflect.get(repository, key, receiver);
			// The provider of the call, if its scope replaces the declared one.
			return key === "provider" && state.scope
				? (state.scope.providers.get(value) ?? value)
				: value;
		},
		set: (_target, key, value) => Reflect.set(repository, key, value),
		defineProperty: (_target, key, descriptor) =>
			Reflect.defineProperty(repository, key, descriptor),
		deleteProperty: (_target, key) => Reflect.deleteProperty(repository, key),
	});
	const bind = (target: object, name: string, receiver: object) => {
		const method = (target as Record<string, (...args: unknown[]) => unknown>)[
			name
		] as (...args: unknown[]) => unknown;
		bound[name] = async (...args: unknown[]) => {
			if (!state.active) throw new InvalidUseCaseDependencies({ source });
			const started = clock();
			const result = await method.apply(receiver, args);
			writeLog(loggerOfCall(state), "debug", "repository", {
				repository: repositoryName,
				method: name,
				useCase: source,
				ms: elapsed(started),
			});
			for (const arg of args) pullEntities(arg, Entity, state.events);
			pullEntities(result, Entity, state.events);
			return result;
		};
	};
	for (const name of methodNamesOf(repository)) bind(repository, name, view);
	if (overrides) {
		for (const name of new Set([
			...methodNamesOf(repository),
			...methodNamesOf(overrides),
		])) {
			if (typeof (overrides as Record<string, unknown>)[name] === "function") {
				bind(overrides, name, overrides);
			}
		}
	}
	bound.entity = Entity;
	bound.actions = repository.actions;
	return Object.freeze(bound);
}

/**
 * The context a child gets: the keys of its own context blueprint picked from
 * the one of its parent. A child without a context gets none.
 */
function narrowedContext(
	Child: AnyUseCaseClass,
	parent: object | undefined,
): object | undefined {
	if (!Child.context || parent === undefined) return undefined;
	const picked: Record<string, unknown> = {};
	for (const key of Object.keys(Child.context.properties)) {
		if (Object.hasOwn(parent, key)) {
			picked[key] = (parent as Record<string, unknown>)[key];
		}
	}
	return picked;
}

/** Whether `value` can replace `dependency` in `execute`. */
function isOverrideOf(dependency: UseCaseDependency, value: unknown): boolean {
	if (isLoggerDeclaration(dependency)) return isLogger(value);
	if (isRepository(dependency) || isEnvironment(dependency)) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	return typeof value === "function";
}

/** An operation with validated input, dependency functions and a drainable event queue. */
export abstract class AbstractUseCase<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
> {
	readonly input: Readonly<BlueprintValue<Input>>;

	constructor(input: BlueprintInput<Input>, ...args: unknown[]) {
		const declaration = this.constructor as unknown as RuntimeDeclaration;
		const source = declaration.useCaseName;
		const parsed = declaration.blueprint.safeParse(input);
		if (parsed.issues) invalidValue(parsed.issues, source, "input");
		this.input = parsed.value as BlueprintValue<Input>;
		const options = args[0] as
			| { context?: unknown; [ScopeKey]?: ExecutionScope }
			| undefined;
		const scope = options?.[ScopeKey];
		let context: object | undefined;
		if (declaration.context) {
			const checked = declaration.context.safeParse(options?.context);
			if (checked.issues) invalidValue(checked.issues, source, "context");
			context = Object.freeze(checked.value as object);
		}
		// `context` is typed by `UseCaseConstructor`, which knows the declaration.
		Object.defineProperty(this, "context", {
			value: context,
			enumerable: true,
		});
		Object.defineProperty(this, "input", {
			writable: false,
			configurable: false,
		});

		const implementation = this.execute;
		if (typeof implementation !== "function") {
			throw new InvalidUseCaseDeclaration({
				source,
				details: { reason: "Implement execute as a prototype method." },
			});
		}
		const state: ExecutionState = {
			context,
			scope,
			started: false,
			active: false,
			events: [],
			dependencies: Object.create(null),
			owner: this.constructor,
		};
		states.set(this, state);
		for (const [key, dependency] of Object.entries(declaration.dependencies)) {
			if (isRepository(dependency)) {
				state.dependencies[key] = bindRepository(
					dependency,
					undefined,
					state,
					source,
				);
				continue;
			}
			if (isLoggerDeclaration(dependency)) {
				// The logger of the call, resolved on use: a started application
				// can give one after the use case was built.
				Object.defineProperty(state.dependencies, key, {
					get: () => loggerOfCall(state) ?? silentLogger,
					enumerable: true,
				});
				continue;
			}
			if (isEnvironment(dependency)) {
				// Read on use, so that a use case is built without its environment;
				// a command running the call may give its variables instead.
				Object.defineProperty(state.dependencies, key, {
					get: () =>
						state.scope?.environments?.get(dependency) ?? dependency.load(),
					enumerable: true,
				});
				continue;
			}
			const Child = dependency;
			state.dependencies[key] = async (value: unknown) => {
				if (!state.active) throw new InvalidUseCaseDependencies({ source });
				const child = new Child(value, {
					context: narrowedContext(Child, state.context),
					[ScopeKey]: state.scope,
				});
				try {
					return await child.execute();
				} finally {
					state.events.push(...child.pullEvents());
				}
			};
		}
		Object.freeze(state.dependencies);
		// Own, immutable wrapper: subclasses implement only the prototype method.
		Object.defineProperty(this, "execute", {
			value: async (overrides: unknown = {}) => {
				if (state.started) throw new UseCaseAlreadyExecuted({ source });
				state.started = true;
				if (
					typeof overrides !== "object" ||
					overrides === null ||
					Array.isArray(overrides) ||
					Reflect.ownKeys(overrides).some(
						(key) =>
							typeof key !== "string" ||
							!Object.hasOwn(declaration.dependencies, key) ||
							!isOverrideOf(
								declaration.dependencies[key] as UseCaseDependency,
								(overrides as Record<string, unknown>)[key],
							),
					)
				) {
					throw new InvalidUseCaseDependencies({ source });
				}
				const replaced = overrides as Record<string, unknown>;
				const dependencies: Record<string, unknown> = {};
				for (const key of Object.keys(declaration.dependencies)) {
					if (!Object.hasOwn(replaced, key)) {
						dependencies[key] = state.dependencies[key];
					}
				}
				for (const [key, substitute] of Object.entries(replaced)) {
					const dependency = declaration.dependencies[key] as UseCaseDependency;
					if (isRepository(dependency)) {
						dependencies[key] = bindRepository(
							dependency,
							substitute as object,
							state,
							source,
						);
						continue;
					}
					if (isLoggerDeclaration(dependency)) {
						dependencies[key] = substitute;
						continue;
					}
					if (isEnvironment(dependency)) {
						const parsed = dependency.blueprint.safeParse(substitute);
						if (parsed.issues) throw new InvalidUseCaseDependencies({ source });
						dependencies[key] = Object.freeze(parsed.value);
						continue;
					}
					const Child = dependency as AnyUseCaseClass;
					dependencies[key] = async (value: unknown) => {
						if (!state.active) throw new InvalidUseCaseDependencies({ source });
						const childSource = Child.useCaseName;
						const input = Child.blueprint.safeParse(value);
						if (input.issues) invalidValue(input.issues, childSource, "input");
						const output = Child.response.safeParse(
							await guard(
								{ layer: ExceptionLayers.UseCase, source: childSource },
								() => (substitute as (input: unknown) => unknown)(input.value),
							),
						);
						if (output.issues)
							invalidValue(output.issues, childSource, "response");
						collectEvents(Child.response, output.value, state.events);
						return output.value;
					};
				}
				state.resolved = Object.freeze(dependencies);
				state.active = true;
				const started = clock();
				try {
					const result = await guard(
						{ layer: ExceptionLayers.UseCase, source },
						() =>
							implementation.call(
								this,
								state.resolved as DependencyOverrides<Dependencies>,
							),
					);
					const parsed = declaration.response.safeParse(result);
					if (parsed.issues) invalidValue(parsed.issues, source, "response");
					collectEvents(declaration.response, parsed.value, state.events);
					writeLog(loggerOfCall(state), "debug", "use-case", {
						useCase: source,
						outcome: "ok",
						ms: elapsed(started),
					});
					return parsed.value;
				} catch (error) {
					logFailure(
						loggerOfCall(state),
						"use-case-failed",
						{ useCase: source, ms: elapsed(started) },
						error,
					);
					throw error;
				} finally {
					state.active = false;
					state.resolved = undefined;
				}
			},
		});
	}

	/** Default parameter for implementations: `execute(deps = this.dependencies)`. */
	get dependencies(): DependencyFunctions<Dependencies> {
		const state = states.get(this);
		return (state?.resolved ??
			state?.dependencies) as DependencyFunctions<Dependencies>;
	}

	abstract execute(
		dependencies?: DependencyOverrides<Dependencies>,
	): Promise<BlueprintValue<Output>>;

	/** Immediately drains collected events; never executes their handlers. */
	pullEvents(): EntityEvent[] {
		return states.get(this)?.events.splice(0) ?? [];
	}
}

/** What every use case class carries, abstract or not. */
type UseCaseStatics<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined,
> = {
	readonly [Kind]: "use-case";
	readonly useCaseName: string;
	readonly blueprint: IBlueprint<Input>;
	readonly response: IBlueprint<Output>;
	readonly dependencies: Dependencies;
	/** The blueprint of the context of each call, or `undefined`. */
	readonly context: Context extends IBlueprintCollection
		? IBlueprint<Context>
		: undefined;
	readonly description: string | undefined;
	readonly tags: readonly string[];
	readonly deprecated: boolean;
	/** The exceptions a caller should expect. */
	readonly errors: readonly AnyExceptionClass[];
};

/** What a use case instance carries beyond `AbstractUseCase`. */
type UseCaseInstanceContext<Context extends IBlueprintCollection | undefined> =
	{
		/** What the caller supplied with the call, parsed and frozen; `undefined` without a declared context. */
		readonly context: Context extends IBlueprintCollection
			? Readonly<BlueprintValue<Context>>
			: undefined;
	};

export type UseCaseConstructor<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined = undefined,
> = (abstract new (
	input: BlueprintInput<Input>,
	...options: OptionsArgs<Context>
) => AbstractUseCase<Input, Output, Dependencies> &
	UseCaseInstanceContext<Context>) &
	UseCaseStatics<Input, Output, Dependencies, Context>;

/**
 * What `useCaseOf` gives with `steps`: concrete, its `execute` interprets the
 * steps. A subclass may still override `execute`.
 */
export type StepsUseCaseConstructor<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
	Context extends IBlueprintCollection | undefined = undefined,
> = (new (
	input: BlueprintInput<Input>,
	...options: OptionsArgs<Context>
) => Omit<AbstractUseCase<Input, Output, Dependencies>, "execute"> &
	UseCaseInstanceContext<Context> & {
		execute(
			dependencies?: DependencyOverrides<Dependencies>,
		): Promise<BlueprintValue<Output>>;
	}) &
	UseCaseStatics<Input, Output, Dependencies, Context>;

/**
 * Declares an operation. With `steps` the class is concrete: its `execute`
 * interprets them. Without, it is abstract: extend it and implement an async
 * execute method.
 */
export function useCaseOf<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	const Dependencies extends UseCaseCollection = Record<never, never>,
	Context extends IBlueprintCollection | undefined = undefined,
	const Steps extends
		| readonly UseCaseStep<NoInfer<Dependencies>>[]
		| undefined = undefined,
	Strict extends boolean = false,
>(
	settings: UseCaseDeclaration<
		Input,
		Output,
		Dependencies,
		Context,
		Steps,
		Strict
	>,
): [Steps] extends [undefined]
	? UseCaseConstructor<Input, Output, Dependencies, Context>
	: StepsUseCaseConstructor<Input, Output, Dependencies, Context>;
export function useCaseOf(
	settings: UseCaseSettings<
		IBlueprintCollection,
		IBlueprintCollection,
		UseCaseCollection,
		IBlueprintCollection | undefined
	> & { readonly steps?: unknown; readonly strictSteps?: unknown },
): unknown {
	type Input = IBlueprintCollection;
	type Output = IBlueprintCollection;
	type Dependencies = UseCaseCollection;
	type Context = IBlueprintCollection | undefined;
	const { name, blueprint, response, context } = settings;
	const { description, deprecated = false } = settings;
	const tags = settings.tags === undefined ? [] : settings.tags;
	const errors = settings.errors === undefined ? [] : settings.errors;
	const dependencies =
		settings.dependencies === undefined ? {} : settings.dependencies;
	if (
		typeof name !== "string" ||
		!name.trim() ||
		!isBlueprint(blueprint) ||
		blueprint.optional ||
		!isBlueprint(response) ||
		response.optional ||
		typeof dependencies !== "object" ||
		dependencies === null ||
		Array.isArray(dependencies) ||
		Reflect.ownKeys(dependencies).some(
			(key) =>
				typeof key !== "string" ||
				!isDependency((dependencies as UseCaseCollection)[key]),
		)
	) {
		throw new InvalidUseCaseDeclaration({
			source: typeof name === "string" ? name : "useCaseOf",
			details: {
				reason:
					"Expected a name, input and response blueprints, and UseCase classes, repositories, environments or Logger as dependencies.",
			},
		});
	}
	const invalidSetting = (reason: string): never => {
		throw new InvalidUseCaseDeclaration({ source: name, details: { reason } });
	};
	if (context !== undefined && (!isBlueprint(context) || context.optional)) {
		invalidSetting("Expected context to be a non-optional blueprint.");
	}
	if (description !== undefined && typeof description !== "string") {
		invalidSetting("Expected description to be a string.");
	}
	if (typeof deprecated !== "boolean") {
		invalidSetting("Expected deprecated to be a boolean.");
	}
	if (
		settings.strictSteps !== undefined &&
		typeof settings.strictSteps !== "boolean"
	) {
		invalidSetting("Expected strictSteps to be a boolean.");
	}
	if (
		!Array.isArray(tags) ||
		tags.some((tag) => typeof tag !== "string" || tag === "") ||
		new Set(tags).size !== tags.length
	) {
		invalidSetting("Expected tags to be distinct, non-empty strings.");
	}
	if (
		!Array.isArray(errors) ||
		!errors.every(isDeclaredException) ||
		new Set(errors).size !== errors.length
	) {
		invalidSetting(
			"Expected errors to be distinct classes made by exceptionOf.",
		);
	}
	if (settings.steps !== undefined) {
		validateSteps(
			{ name, blueprint, context, dependencies, errors },
			settings.steps,
		);
	}
	abstract class DeclaredUseCase extends AbstractUseCase<
		Input,
		Output,
		Dependencies
	> {
		static readonly [Kind] = "use-case" as const;
		static readonly useCaseName = name;
		static readonly blueprint = blueprint;
		static readonly response = response;
		static readonly dependencies = Object.freeze({
			...dependencies,
		}) as Dependencies;
		static readonly context = context as Context extends IBlueprintCollection
			? IBlueprint<Context>
			: undefined;
		static readonly description = description;
		static readonly tags = Object.freeze([...tags]);
		static readonly deprecated = deprecated;
		static readonly errors = Object.freeze([
			...errors,
		]) as readonly AnyExceptionClass[];
	}
	Object.defineProperty(DeclaredUseCase, "name", { value: name });
	if (settings.steps !== undefined) {
		Object.defineProperty(DeclaredUseCase, "steps", {
			value: freezeData(settings.steps),
		});
		Object.defineProperty(DeclaredUseCase.prototype, "execute", {
			value: executeSteps,
			writable: true,
			configurable: true,
		});
	}
	return DeclaredUseCase;
}

/** Whether `value` can be a dependency of a use case. */
function isDependency(value: unknown): value is UseCaseDependency {
	return (
		isUseCaseClass(value) ||
		isRepository(value) ||
		isEnvironment(value) ||
		isLoggerDeclaration(value)
	);
}

export function isUseCaseClass(value: unknown): value is AnyUseCaseClass {
	return (
		typeof value === "function" &&
		value.prototype instanceof AbstractUseCase &&
		(value as unknown as { [Kind]?: string })[Kind] === "use-case" &&
		typeof value.prototype.execute === "function"
	);
}

export function isUseCase(
	value: unknown,
): value is AbstractUseCase<
	IBlueprintCollection,
	IBlueprintCollection,
	UseCaseCollection
> {
	return value instanceof AbstractUseCase;
}
