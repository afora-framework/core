import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	BlueprintField,
	BlueprintInput,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isEntity } from "../entity/entity";
import type { EntityEvent } from "../entity/event";
import {
	type AnyEnvironment,
	type EnvironmentValue,
	isEnvironment,
} from "../environment/environment";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception, exceptionOf } from "../exception/exception";
import { guard } from "../exception/guard";
import type { Issue } from "../parse/types/parse.interface";
import { AbstractRepository, isRepository } from "../repository/repository";
import type { AnyRepository } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";

/** A concrete UseCase declaration, usable as a dependency. */
export interface AnyUseCaseClass {
	readonly [Kind]: "use-case";
	readonly useCaseName: string;
	readonly blueprint: AnyBlueprint;
	readonly response: AnyBlueprint;
	readonly dependencies: UseCaseCollection;
	new (
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous concrete UseCase constructors
		input: any,
	): {
		execute(): Promise<unknown>;
		pullEvents(): EntityEvent[];
	};
}

/**
 * What a use case can depend on: another use case, a repository made by
 * `repositoryOf`, or an environment made by `environmentOf`.
 */
export type UseCaseDependency =
	| AnyUseCaseClass
	| AnyRepository
	| AnyEnvironment;

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

/**
 * What a use case gets for a dependency: a function for a use case, the
 * repository itself, or the variables of an environment.
 */
export type DependencyOf<Dependency> = Dependency extends AnyUseCaseClass
	? (input: UseCaseInput<Dependency>) => Promise<UseCaseResponse<Dependency>>
	: Dependency extends AnyEnvironment
		? EnvironmentValue<Dependency>
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
> {
	readonly name: string;
	readonly blueprint: IBlueprint<Input>;
	readonly response: IBlueprint<Output>;
	readonly dependencies?: Dependencies;
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
}
interface ExecutionState {
	started: boolean;
	active: boolean;
	readonly events: EntityEvent[];
	readonly dependencies: Record<string, unknown>;
	resolved?: Record<string, unknown>;
}
const states = new WeakMap<object, ExecutionState>();

function invalidValue(
	issues: readonly Issue[],
	source: string,
	phase: string,
): never {
	throw new Exception({
		layer: ExceptionLayers.UseCase,
		name: phase === "input" ? "InvalidUseCaseInput" : "InvalidUseCaseResponse",
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
		const shape = isBlueprint(field)
			? field
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
	const bound: Record<string, unknown> = Object.create(null);
	// What the methods of the repository get as `this`: the bound methods, and the
	// repository for the rest, as the receiver, so that its getters see the view.
	const view: object = new Proxy(Object.create(repository), {
		get: (_target, key, receiver) =>
			typeof key === "string" && Object.hasOwn(bound, key)
				? bound[key]
				: Reflect.get(repository, key, receiver),
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
			const result = await method.apply(receiver, args);
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

/** Whether `value` can replace `dependency` in `execute`. */
function isOverrideOf(dependency: UseCaseDependency, value: unknown): boolean {
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

	constructor(input: BlueprintInput<Input>) {
		const declaration = this.constructor as unknown as RuntimeDeclaration;
		const source = declaration.useCaseName;
		const parsed = declaration.blueprint.safeParse(input);
		if (parsed.issues) invalidValue(parsed.issues, source, "input");
		this.input = parsed.value as BlueprintValue<Input>;
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
			started: false,
			active: false,
			events: [],
			dependencies: Object.create(null),
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
			if (isEnvironment(dependency)) {
				// Read on use, so that a use case is built without its environment.
				Object.defineProperty(state.dependencies, key, {
					get: () => dependency.load(),
					enumerable: true,
				});
				continue;
			}
			const Child = dependency;
			state.dependencies[key] = async (value: unknown) => {
				if (!state.active) throw new InvalidUseCaseDependencies({ source });
				const child = new Child(value);
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
					return parsed.value;
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

export type UseCaseConstructor<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	Dependencies extends UseCaseCollection,
> = (abstract new (
	input: BlueprintInput<Input>,
) => AbstractUseCase<Input, Output, Dependencies>) & {
	readonly [Kind]: "use-case";
	readonly useCaseName: string;
	readonly blueprint: IBlueprint<Input>;
	readonly response: IBlueprint<Output>;
	readonly dependencies: Dependencies;
};

/** Declares an abstract operation. Extend it and implement an async execute method. */
export function useCaseOf<
	Input extends IBlueprintCollection,
	Output extends IBlueprintCollection,
	const Dependencies extends UseCaseCollection = Record<never, never>,
>(
	settings: UseCaseSettings<Input, Output, Dependencies>,
): UseCaseConstructor<Input, Output, Dependencies> {
	const { name, blueprint, response } = settings;
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
					"Expected a name, input and response blueprints, and UseCase classes, repositories or environments as dependencies.",
			},
		});
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
	}
	Object.defineProperty(DeclaredUseCase, "name", { value: name });
	return DeclaredUseCase;
}

/** Whether `value` can be a dependency of a use case. */
function isDependency(value: unknown): value is UseCaseDependency {
	return isUseCaseClass(value) || isRepository(value) || isEnvironment(value);
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
