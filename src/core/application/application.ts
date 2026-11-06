import { fieldOf } from "../blueprint/callable";
import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { ENTITY_IDENTITY_KEYS } from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import { isEnvironment } from "../environment/environment";
import { declaredMessageOf, isDeclaredException } from "../exception/exception";
import { isExportedException } from "../exception/exported";
import { plainOf } from "../openapi/openapi";
import { isProperty } from "../property/is-property";
import { type PropertyLineage, propertyLineageOf } from "../property/lineage";
import { pluginsOf } from "../record/plugin";
import { providerDescriptionOf } from "../repository/provider";
import {
	bindRepository,
	inspectRepository,
	type RepositoryInspection,
} from "../repository/state";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { type AnyUseCaseClass, isUseCaseClass } from "../use-case/use-case";
import {
	ApplicationConflict,
	DuplicateApplicationDeclaration,
	InvalidApplicationDeclaration,
	UnregisteredApplicationReference,
	UnregisteredRepositoryDependency,
	UnregisteredUseCaseDependency,
} from "./exceptions";
import type {
	AnyApplication,
	ApplicationCollectionKey,
	ApplicationCollections,
	ApplicationDescription,
	ApplicationSettings,
	FieldDescription,
	FieldsDescription,
	IApplication,
	MergedCollections,
	PropertyDescription,
	PropertyLineageDescription,
	PropertyReference,
	RecordDescription,
} from "./types/application.interface";

const KEYS = [
	"properties",
	"blueprints",
	"records",
	"entities",
	"environments",
	"repositories",
	"useCases",
	"exceptions",
] as const satisfies readonly ApplicationCollectionKey[];

/** One registered declaration. */
interface Entry {
	readonly collection: ApplicationCollectionKey;
	readonly name: string;
	readonly value: unknown;
	/** What tells two declarations apart: the object itself, but for blueprints and repositories. */
	readonly key: object;
	/** The application that registered it. */
	readonly from: string;
}

type Registry = Record<ApplicationCollectionKey, Map<string, Entry>>;

/** The resolved declarations of each application, and its bound repositories. */
const internals = new WeakMap<object, Registry>();

const KIND_OF: Readonly<Record<ApplicationCollectionKey, string>> = {
	properties: "property",
	blueprints: "blueprint",
	records: "record",
	entities: "entity",
	environments: "environment",
	repositories: "repository",
	useCases: "use case",
	exceptions: "exception",
};

/** Whether `value` is an application made by `applicationOf`. */
export function isApplication(value: unknown): value is AnyApplication {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "application"
	);
}

function invalid(source: string, reason: string): never {
	throw new InvalidApplicationDeclaration({ source, details: { reason } });
}

/** Whether `value` is a declaration of `collection`'s kind. */
function isOfKind(collection: ApplicationCollectionKey, value: unknown) {
	switch (collection) {
		case "properties":
			return isProperty(value);
		case "blueprints":
			return isBlueprint(value);
		case "records":
			return isRecordClass(value) && !isEntityClass(value);
		case "entities":
			return isEntityClass(value);
		case "environments":
			return isEnvironment(value);
		case "repositories":
			return inspectRepository(value) !== undefined;
		case "useCases":
			return isUseCaseClass(value);
		case "exceptions":
			return isDeclaredException(value);
	}
}

function keyOf(collection: ApplicationCollectionKey, value: unknown): object {
	switch (collection) {
		case "properties":
			return fieldOf(value as BlueprintField) as object;
		case "blueprints":
			return (value as AnyBlueprint).properties;
		case "repositories":
			return (inspectRepository(value) as RepositoryInspection).state;
		default:
			return value as object;
	}
}

function emptyRegistry(): Registry {
	return Object.fromEntries(
		KEYS.map((key) => [key, new Map<string, Entry>()]),
	) as Registry;
}

/** Adds the declarations of `settings`, after those of the applications it extends. */
function resolve(
	settings: ApplicationSettings<
		string,
		readonly AnyApplication[],
		ApplicationCollections
	>,
): Registry {
	const registry = emptyRegistry();
	const byKey = new Map<object, Entry>();
	const source = settings.name;

	const add = (entry: Entry): void => {
		const same = registry[entry.collection].get(entry.name);
		if (same) {
			if (same.key === entry.key) return;
			conflict(
				`${KIND_OF[entry.collection]} "${entry.name}" is declared as different objects by "${same.from}" and by "${entry.from}".`,
				same,
				entry,
			);
		}
		const other = byKey.get(entry.key);
		if (other) {
			if (other.from === entry.from) {
				throw new DuplicateApplicationDeclaration({
					source,
					details: {
						first: `${KIND_OF[other.collection]} "${other.name}"`,
						second: `${KIND_OF[entry.collection]} "${entry.name}"`,
					},
				});
			}
			conflict(
				`The same ${KIND_OF[entry.collection]} is ${KIND_OF[other.collection]} "${other.name}" in "${other.from}" and ${KIND_OF[entry.collection]} "${entry.name}" in "${entry.from}".`,
				other,
				entry,
			);
		}
		registry[entry.collection].set(entry.name, entry);
		byKey.set(entry.key, entry);
	};
	const conflict = (reason: string, first: Entry, second: Entry): never => {
		throw new ApplicationConflict({
			source,
			details: {
				reason,
				origins: [first.from, second.from],
				declarations: [
					`${KIND_OF[first.collection]} ${first.name}`,
					`${KIND_OF[second.collection]} ${second.name}`,
				],
			},
		});
	};

	for (const other of settings.extends ?? []) {
		const resolved = internals.get(other);
		if (!resolved) invalid(source, "Expected `extends` to hold applications.");
		for (const key of KEYS) {
			for (const entry of (resolved as Registry)[key].values()) add(entry);
		}
	}

	for (const collection of KEYS) {
		const declared = settings[collection];
		if (declared === undefined) continue;
		if (
			typeof declared !== "object" ||
			declared === null ||
			Array.isArray(declared)
		) {
			invalid(
				source,
				`Expected ${collection} to be an object of declarations.`,
			);
		}
		for (const [name, value] of Object.entries(declared)) {
			if (!isOfKind(collection, value)) {
				invalid(
					source,
					`${collection}.${name} is not a ${KIND_OF[collection]} (${collection} takes ${KIND_OF[collection]} declarations).`,
				);
			}
			const declaredName =
				collection === "useCases"
					? (value as AnyUseCaseClass).useCaseName
					: collection === "exceptions"
						? (value as { name: string }).name
						: name;
			if (declaredName !== name) {
				invalid(
					source,
					`${collection}.${name} must be keyed by its name, "${declaredName}".`,
				);
			}
			add({
				collection,
				name,
				value,
				key: keyOf(collection, value),
				from: source,
			});
		}
	}
	return registry;
}

/** The records and entities `properties` hold, through blueprints and lists. */
function recordsIn(properties: IBlueprintCollection): Set<object> {
	const found = new Set<object>();
	const visit = (field: unknown): void => {
		if (isBlueprintList(field)) visit(field.item);
		else if (isBlueprint(field)) walk(field.properties);
		else {
			const record = recordFieldOf(field)?.record;
			if (record) found.add(record);
		}
	};
	const walk = (collection: IBlueprintCollection): void => {
		for (const field of Object.values(collection)) visit(field);
	};
	walk(properties);
	return found;
}

/** Checks the resolved set as a whole; throws on the first reference left outside it. */
function validate(source: string, registry: Registry): void {
	const registered = new Set<object>([
		...[...registry.records.values()].map((entry) => entry.key),
		...[...registry.entities.values()].map((entry) => entry.key),
	]);
	const holders: readonly (readonly [ApplicationCollectionKey, string])[] = [
		["blueprints", "properties"],
		["records", "blueprint.properties"],
		["entities", "blueprint.properties"],
	];
	for (const [collection] of holders) {
		for (const entry of registry[collection].values()) {
			const properties =
				collection === "blueprints"
					? (entry.value as AnyBlueprint).properties
					: (entry.value as { blueprint: AnyBlueprint }).blueprint.properties;
			for (const record of recordsIn(properties)) {
				if (registered.has(record)) continue;
				throw new UnregisteredApplicationReference({
					source,
					details: {
						holder: `${KIND_OF[collection]} "${entry.name}"`,
						reference: `${isEntityClass(record) ? "entity" : "record"} "${(record as { name: string }).name}"`,
					},
				});
			}
		}
	}

	const repositories = new Set(
		[...registry.repositories.values()].map((entry) => entry.key),
	);
	const environments = new Set(
		[...registry.environments.values()].map((entry) => entry.key),
	);
	const unregistered = (repository: string, dependency: string): never => {
		throw new UnregisteredRepositoryDependency({
			source,
			details: { repository, dependency },
		});
	};
	for (const entry of registry.repositories.values()) {
		const info = inspectRepository(entry.value) as RepositoryInspection;
		if (!registered.has(info.entity)) {
			unregistered(entry.name, `entity "${info.entity.name}"`);
		}
		for (const relation of info.relations) {
			if (!repositories.has(relation)) {
				unregistered(
					entry.name,
					`the repository of "${(relation as { entity: { name: string } }).entity.name}"`,
				);
			}
		}
		for (const environment of info.environments) {
			if (!environments.has(environment)) {
				unregistered(entry.name, "an environment");
			}
		}
	}
}

/** Checks the use cases of the resolved set: dependencies, records and errors. */
function validateUseCases(source: string, registry: Registry): void {
	const registered = new Set<object>([
		...[...registry.records.values()].map((entry) => entry.key),
		...[...registry.entities.values()].map((entry) => entry.key),
	]);
	const known = (collection: ApplicationCollectionKey) =>
		new Set([...registry[collection].values()].map((entry) => entry.key));
	const useCases = known("useCases");
	const repositories = known("repositories");
	const environments = known("environments");
	const exceptions = known("exceptions");
	for (const entry of registry.useCases.values()) {
		const UseCase = entry.value as AnyUseCaseClass;
		for (const [key, dependency] of Object.entries(UseCase.dependencies)) {
			const found = isUseCaseClass(dependency)
				? useCases.has(dependency)
				: isEnvironment(dependency)
					? environments.has(dependency)
					: repositories.has(
							(inspectRepository(dependency) as RepositoryInspection).state,
						);
			if (!found) {
				throw new UnregisteredUseCaseDependency({
					source,
					details: { useCase: `"${entry.name}"`, dependency: `"${key}"` },
				});
			}
		}
		for (const [part, blueprint] of [
			["blueprint", UseCase.blueprint],
			["response", UseCase.response],
			["context", UseCase.context],
		] as const) {
			if (blueprint === undefined) continue;
			for (const record of recordsIn(blueprint.properties)) {
				if (registered.has(record)) continue;
				throw new UnregisteredApplicationReference({
					source,
					details: {
						holder: `the ${part} of use case "${entry.name}"`,
						reference: `${isEntityClass(record) ? "entity" : "record"} "${(record as { name: string }).name}"`,
					},
				});
			}
		}
		for (const Thrown of UseCase.errors) {
			if (exceptions.has(Thrown) || isExportedException(Thrown)) continue;
			throw new UnregisteredApplicationReference({
				source,
				details: {
					holder: `use case "${entry.name}"`,
					reference: `exception "${Thrown.name}"`,
				},
			});
		}
	}
}

/** `value` as JSON: a `RegExp` as its source, what JSON cannot hold left out. */
function jsonOf<Value>(value: Value): Value {
	return JSON.parse(
		JSON.stringify(value, (_key, item) =>
			item instanceof RegExp ? item.source : item,
		),
	);
}

/** What a field is called in the application: the name of each registered class or blueprint. */
type References = ReadonlyMap<object, string>;

function referencesOf(
	registry: Registry,
	collection: ApplicationCollectionKey,
): References {
	return new Map(
		[...registry[collection].values()].map((entry) => [entry.key, entry.name]),
	);
}

interface Scope {
	readonly properties: References;
	readonly blueprints: References;
	readonly records: References;
	readonly entities: References;
}

function propertyReferenceOf(
	Property: BlueprintField,
	scope: Scope,
): PropertyReference {
	const ref = scope.properties.get(fieldOf(Property) as object);
	return ref === undefined ? propertyDescriptionOf(Property, scope) : { ref };
}

function lineageDescriptionOf(
	lineage: PropertyLineage,
	scope: Scope,
): PropertyLineageDescription {
	switch (lineage.kind) {
		case "refined":
			return {
				kind: "refined",
				base: propertyReferenceOf(lineage.base, scope),
				options: jsonOf(lineage.options),
			};
		case "optional":
			return {
				kind: "optional",
				base: propertyReferenceOf(lineage.base, scope),
			};
		case "factory":
			return {
				kind: "factory",
				factory: lineage.factory,
				args: jsonOf(lineage.args),
			};
	}
}

/** A property in full; it never throws, whatever the property is made of. */
function propertyDescriptionOf(
	Property: BlueprintField,
	scope: Scope,
): PropertyDescription {
	const { type } = Property as {
		readonly type: {
			readonly name: string;
			readonly optional?: boolean;
			readonly sensitive?: boolean;
			readonly unique?: boolean;
			readonly schema: { readonly type: { Type(): unknown } };
		};
	};
	const lineage = propertyLineageOf(Property);
	return {
		name: type.name,
		optional: type.optional === true,
		sensitive: type.sensitive === true,
		unique: type.unique === true,
		schema: plainOf(type.schema.type.Type()) as Record<string, unknown>,
		...(lineage ? { lineage: lineageDescriptionOf(lineage, scope) } : {}),
	};
}

function fieldDescriptionOf(field: unknown, scope: Scope): FieldDescription {
	if (isProperty(field)) {
		const real = fieldOf(field);
		const ref = scope.properties.get(real as object);
		return ref === undefined
			? { kind: "property", ...propertyDescriptionOf(real, scope) }
			: { kind: "property", ref, optional: real.type.optional === true };
	}
	if (isBlueprintList(field)) {
		return {
			kind: "list",
			item: fieldDescriptionOf(field.item, scope),
			optional: field.optional,
			...(field.minItems === undefined ? {} : { minItems: field.minItems }),
			...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
		};
	}
	if (isBlueprint(field)) {
		const ref = scope.blueprints.get(field.properties);
		return ref === undefined
			? {
					kind: "blueprint",
					optional: field.optional,
					fields: fieldsDescriptionOf(field.properties, scope),
				}
			: { kind: "blueprint", ref, optional: field.optional };
	}
	const record = recordFieldOf(field);
	if (record) {
		const entity = scope.entities.get(record.record);
		const ref = entity ?? scope.records.get(record.record);
		return {
			kind: entity === undefined ? "record" : "entity",
			ref: ref ?? record.record.name,
			optional: record.optional,
		};
	}
	// Not a field at all: nothing is known about it.
	return {
		kind: "property",
		name: "unknown",
		optional: false,
		sensitive: false,
		unique: false,
		schema: {},
	};
}

function fieldsDescriptionOf(
	properties: IBlueprintCollection,
	scope: Scope,
	skip: ReadonlySet<string> = new Set(),
): FieldsDescription {
	return Object.fromEntries(
		Object.entries(properties)
			.filter(([key]) => !skip.has(key))
			.map(([key, field]) => [key, fieldDescriptionOf(field, scope)]),
	);
}

function recordDescriptionOf(entry: Entry, scope: Scope): RecordDescription {
	const Record = entry.value as {
		readonly blueprint: AnyBlueprint;
		readonly options: {
			readonly sensitive: readonly string[];
			readonly unique: readonly string[];
			readonly change: readonly string[];
		};
	};
	const plugins = pluginsOf(Record).map((plugin) => plugin.toJSON());
	const skip = new Set<string>(plugins.flatMap((plugin) => plugin.keys));
	if (entry.collection === "entities") {
		for (const key of ENTITY_IDENTITY_KEYS) skip.add(key);
	}
	// Keys the options list on their own: not those a property or a plugin implies.
	const own = (keys: readonly string[], flag?: "sensitive" | "unique") =>
		keys.filter((key) => {
			if (skip.has(key)) return false;
			const field = Record.blueprint.properties[key];
			return !(flag && isProperty(field) && field.type[flag] === true);
		});
	return {
		from: entry.from,
		fields: fieldsDescriptionOf(Record.blueprint.properties, scope, skip),
		options: {
			sensitive: own(Record.options.sensitive, "sensitive"),
			unique: own(Record.options.unique, "unique"),
			change: own(Record.options.change),
		},
		plugins,
	};
}

function describeRegistry(
	name: string,
	extended: readonly AnyApplication[],
	registry: Registry,
	provider: IRepositoryProvider | undefined,
): ApplicationDescription {
	const scope: Scope = {
		properties: referencesOf(registry, "properties"),
		blueprints: referencesOf(registry, "blueprints"),
		records: referencesOf(registry, "records"),
		entities: referencesOf(registry, "entities"),
	};
	const repositories = referencesOf(registry, "repositories");
	const environmentRefs = referencesOf(registry, "environments");
	const useCaseRefs = referencesOf(registry, "useCases");
	const exceptionRefs = referencesOf(registry, "exceptions");
	const each = <Result>(
		collection: ApplicationCollectionKey,
		describe: (entry: Entry) => Result,
	): Readonly<Record<string, Result>> =>
		Object.fromEntries(
			[...registry[collection].values()].map((entry) => [
				entry.name,
				describe(entry),
			]),
		);

	return {
		name,
		extends: extended.map((other) => other.name),
		...(provider === undefined
			? {}
			: { provider: providerDescriptionOf(provider) }),
		properties: each("properties", (entry) => ({
			from: entry.from,
			...propertyDescriptionOf(entry.value as BlueprintField, scope),
		})),
		blueprints: each("blueprints", (entry) => ({
			from: entry.from,
			fields: fieldsDescriptionOf(
				(entry.value as AnyBlueprint).properties,
				scope,
			),
		})),
		records: each("records", (entry) => recordDescriptionOf(entry, scope)),
		entities: each("entities", (entry) => recordDescriptionOf(entry, scope)),
		environments: each("environments", (entry) => ({
			from: entry.from,
			fields: fieldsDescriptionOf(
				(entry.value as { blueprint: AnyBlueprint }).blueprint.properties,
				scope,
			),
		})),
		repositories: each("repositories", (entry) => {
			const info = inspectRepository(entry.value) as RepositoryInspection;
			return {
				from: entry.from,
				entity: scope.entities.get(info.entity) as string,
				actions: info.actions,
				deletion: info.deletion,
				relations: info.relations.map(
					(relation) => repositories.get(relation) as string,
				),
				environments: info.environments.map(
					(environment) => environmentRefs.get(environment) as string,
				),
				...(info.provider === undefined
					? {}
					: { provider: providerDescriptionOf(info.provider) }),
			};
		}),
		useCases: each("useCases", (entry) => {
			const UseCase = entry.value as AnyUseCaseClass;
			return {
				from: entry.from,
				name: UseCase.useCaseName,
				...(UseCase.description === undefined
					? {}
					: { description: UseCase.description }),
				tags: UseCase.tags,
				deprecated: UseCase.deprecated,
				input: fieldsDescriptionOf(UseCase.blueprint.properties, scope),
				response: fieldsDescriptionOf(UseCase.response.properties, scope),
				...(UseCase.context === undefined
					? {}
					: {
							context: fieldsDescriptionOf(UseCase.context.properties, scope),
						}),
				errors: UseCase.errors.map((Thrown) => {
					const ref = exceptionRefs.get(Thrown);
					return ref === undefined
						? { kind: "core" as const, name: Thrown.name }
						: { kind: "exception" as const, ref };
				}),
				dependencies: Object.fromEntries(
					Object.entries(UseCase.dependencies).map(([key, dependency]) => [
						key,
						isUseCaseClass(dependency)
							? { kind: "use-case", ref: useCaseRefs.get(dependency) as string }
							: isEnvironment(dependency)
								? {
										kind: "environment",
										ref: environmentRefs.get(dependency) as string,
									}
								: {
										kind: "repository",
										ref: repositories.get(
											(inspectRepository(dependency) as RepositoryInspection)
												.state,
										) as string,
									},
					]),
				),
				implementation: { kind: "opaque" },
			};
		}),
		exceptions: each("exceptions", (entry) => {
			const Declared = entry.value as Parameters<typeof declaredMessageOf>[0];
			const message = declaredMessageOf(Declared);
			return {
				from: entry.from,
				layer: Declared.layer,
				...(message === undefined ? {} : { message }),
			};
		}),
	};
}

/**
 * A named, immutable manifest of what an application declares, so that all of
 * it runs in one place and can be introspected, e.g.
 * `applicationOf({ name: "blog", entities: { User, Post }, repositories: { Users, Posts } })`.
 *
 * Each collection is `{ Name: declaration }`. At declaration it checks the set
 * as a whole: the same object under two names, an entity or record held (at
 * any depth) by a registered blueprint, record, entity or repository that is
 * not registered, and a repository whose entity, relations or environments
 * are not. `extends` inherits the declarations of other applications: the
 * same object under the same name is registered once, and different objects
 * under one name (or one object under two names) throw `ApplicationConflict`.
 * `describe()` gives the graph. With a `provider` (or that of the last
 * application extended that has one), `repositories` are bound to it.
 */
export function applicationOf<
	const Name extends string,
	const Extended extends readonly AnyApplication[] = readonly [],
	const Properties extends ApplicationCollections["properties"] = Record<
		never,
		never
	>,
	const Blueprints extends ApplicationCollections["blueprints"] = Record<
		never,
		never
	>,
	const Records extends ApplicationCollections["records"] = Record<
		never,
		never
	>,
	const Entities extends ApplicationCollections["entities"] = Record<
		never,
		never
	>,
	const Environments extends ApplicationCollections["environments"] = Record<
		never,
		never
	>,
	const Repositories extends ApplicationCollections["repositories"] = Record<
		never,
		never
	>,
	const UseCases extends ApplicationCollections["useCases"] = Record<
		never,
		never
	>,
	const Exceptions extends ApplicationCollections["exceptions"] = Record<
		never,
		never
	>,
>(
	settings: ApplicationSettings<
		Name,
		Extended,
		{
			properties: Properties;
			blueprints: Blueprints;
			records: Records;
			entities: Entities;
			environments: Environments;
			repositories: Repositories;
			useCases: UseCases;
			exceptions: Exceptions;
		}
	>,
): IApplication<
	Name,
	MergedCollections<
		{
			properties: Properties;
			blueprints: Blueprints;
			records: Records;
			entities: Entities;
			environments: Environments;
			repositories: Repositories;
			useCases: UseCases;
			exceptions: Exceptions;
		},
		Extended
	>
> {
	const { name } = settings ?? {};
	if (typeof name !== "string" || name === "") {
		invalid("applicationOf", "Expected a name.");
	}
	const extended = settings.extends ?? [];
	if (!Array.isArray(extended) || !extended.every(isApplication)) {
		invalid(name, "Expected `extends` to be a list of applications.");
	}
	const registry = resolve(settings);
	validate(name, registry);
	validateUseCases(name, registry);

	const provider: IRepositoryProvider | undefined =
		settings.provider ??
		[...extended].reverse().find((other) => other.provider)?.provider;
	if (provider !== undefined && typeof provider !== "object") {
		invalid(name, "Expected `provider` to be a repository provider.");
	}

	const collection = (key: ApplicationCollectionKey) =>
		Object.freeze(
			Object.fromEntries(
				[...registry[key].values()].map((entry) => [entry.name, entry.value]),
			),
		);

	const bound = new Map<unknown, unknown>();
	const boundByState = new Map<object, unknown>();
	const repositories: Record<string, unknown> = {};
	for (const entry of registry.repositories.values()) {
		const repository =
			provider === undefined
				? entry.value
				: bindRepository(entry.value as object, provider);
		bound.set(entry.value, repository);
		boundByState.set(entry.key, repository);
		repositories[entry.name] = repository;
	}

	// A use case is bound once: a subclass whose dependencies are the bound
	// repositories and the bound use cases, never mutating the declared class.
	const boundUseCases = new Map<AnyUseCaseClass, AnyUseCaseClass>();
	const bindUseCase = (UseCase: AnyUseCaseClass): AnyUseCaseClass => {
		if (provider === undefined) return UseCase;
		const done = boundUseCases.get(UseCase);
		if (done) return done;
		const Declared = UseCase as unknown as new (...args: never[]) => object;
		class Bound extends Declared {}
		Object.defineProperty(Bound, "name", { value: Declared.name });
		boundUseCases.set(UseCase, Bound as unknown as AnyUseCaseClass);
		const dependencies = Object.fromEntries(
			Object.entries(UseCase.dependencies).map(([key, dependency]) => [
				key,
				isUseCaseClass(dependency)
					? bindUseCase(dependency)
					: isEnvironment(dependency)
						? dependency
						: (boundByState.get(
								(inspectRepository(dependency) as RepositoryInspection).state,
							) ?? dependency),
			]),
		);
		Object.defineProperty(Bound, "dependencies", {
			value: Object.freeze(dependencies),
		});
		return Bound as unknown as AnyUseCaseClass;
	};
	const useCases: Record<string, unknown> = {};
	const boundUseCaseOf = new Map<unknown, unknown>();
	for (const entry of registry.useCases.values()) {
		const bound = bindUseCase(entry.value as AnyUseCaseClass);
		boundUseCaseOf.set(entry.value, bound);
		useCases[entry.name] = bound;
	}

	const application = Object.freeze({
		[Kind]: "application" as const,
		name,
		extends: Object.freeze([...extended]),
		provider,
		properties: collection("properties"),
		blueprints: collection("blueprints"),
		records: collection("records"),
		entities: collection("entities"),
		environments: collection("environments"),
		repositories: Object.freeze(repositories),
		useCases: Object.freeze(useCases),
		exceptions: collection("exceptions"),
		useCase(useCase: unknown) {
			if (!boundUseCaseOf.has(useCase)) {
				invalid(name, "Expected a use case registered in the application.");
			}
			return boundUseCaseOf.get(useCase);
		},
		repository(repository: unknown) {
			if (!bound.has(repository)) {
				invalid(name, "Expected a repository registered in the application.");
			}
			return bound.get(repository);
		},
		extend(...others: readonly AnyApplication[]) {
			return applicationOf({
				name,
				extends: [application, ...others],
				...(provider === undefined ? {} : { provider }),
			} as never);
		},
		describe: () => describeRegistry(name, extended, registry, provider),
	});
	internals.set(application, registry);
	return application as never;
}
