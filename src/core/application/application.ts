import { fieldOf } from "../blueprint/callable";
import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import {
	commandOf,
	commandTransactionProvider,
	isCommand,
	verifyCommand,
} from "../command/command";
import type { AnyCommand } from "../command/types/command.interface";
import {
	identityKeysOf,
	isVersionedEntityClass,
} from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import { eventHasHandler, lifecycleEventsOf } from "../entity/event";
import {
	type AnyEnvironment,
	InvalidEnvironment,
	isEnvironment,
} from "../environment/environment";
import {
	eventPolicyDescriptionOf,
	eventPolicyPublishersOf,
} from "../event-policy/event-policy";
import {
	ApplicationPublishersKey,
	bindPublishers,
	isEventPublisher,
	type Publishers,
} from "../event-policy/publishers";
import type { IEventPublisher } from "../event-policy/types/event-policy.interface";
import {
	declaredMessageOf,
	Exception,
	isDeclaredException,
} from "../exception/exception";
import { isExportedException } from "../exception/exported";
import {
	ApplicationLoggerKey,
	applicationLogger,
	checkLogSettings,
	isLoggerDeclaration,
	type LogSettings,
	logProviderNameOf,
	silentLogger,
} from "../logger/logger";
import { plainOf } from "../openapi/openapi";
import { isOutput, outputOf } from "../output/output";
import { stageDescriptionOf } from "../output/stage";
import type { AnyOutput } from "../output/types/output.interface";
import { isProperty } from "../property/is-property";
import { type PropertyLineage, propertyLineageOf } from "../property/lineage";
import { declaredRecordNameOf, recordNameOf } from "../record/name";
import { pluginsOf } from "../record/plugin";
import { providerDescriptionOf } from "../repository/provider";
import { isRepository } from "../repository/repository";
import {
	bindRepository,
	inspectRepository,
	type RepositoryInspection,
} from "../repository/state";
import type { ProviderDescription } from "../repository/types/query.interface";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { useCaseOriginOf } from "../use-case/plugin";
import { describeSteps } from "../use-case/steps/describe";
import { interpretedStepsOf } from "../use-case/steps/run";
import { type AnyUseCaseClass, isUseCaseClass } from "../use-case/use-case";
import {
	ApplicationAlreadyStarted,
	ApplicationConflict,
	DuplicateApplicationDeclaration,
	InvalidApplicationDeclaration,
	InvalidApplicationEnvironment,
	UnregisteredApplicationReference,
	UnregisteredRepositoryDependency,
	UnregisteredUseCaseDependency,
} from "./exceptions";
import {
	isProviderSlot,
	isProviderStorage,
	type ProviderSlot,
	slotEntry,
	slotsOf,
} from "./providers";
import { setStartedApplication, startedApplication } from "./registry";
import {
	checkTransactions,
	deferredEnvironments,
	deferredProvider,
	isDeferredProvider,
	isLogFactory,
	isProviderFactory,
	type LogFactory,
	startDeferred,
	stopProvider,
} from "./start";
import type {
	AnyApplication,
	ApplicationCollectionKey,
	ApplicationCollections,
	ApplicationContext,
	ApplicationDescription,
	ApplicationSettings,
	FieldDescription,
	FieldsDescription,
	IApplication,
	MergedCollections,
	PropertyDescription,
	PropertyLineageDescription,
	PropertyReference,
	ProviderReference,
	RecordDescription,
	UseCaseDescription,
} from "./types/application.interface";

const KEYS = [
	"properties",
	"blueprints",
	"records",
	"entities",
	"environments",
	"repositories",
	"useCases",
	"commands",
	"outputs",
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
/** The `log` each application was declared with (or inherited), for `extends`. */
const logSettings = new WeakMap<object, LogSettings | LogFactory>();

/** A provider of `providersOf` an application registers, by key. */
interface NamedProvider {
	readonly slot: ProviderSlot;
	/** The application that registered its storage. */
	readonly from: string;
	/** What the repositories of the application read and write through. */
	readonly instance: IRepositoryProvider;
}
/** The providers of `providersOf` of each application, for `extends`. */
const namedProviders = new WeakMap<
	object,
	ReadonlyMap<string, NamedProvider>
>();
/** The slot each application's default provider was declared with, if any. */
const defaultSlots = new WeakMap<object, ProviderSlot>();

/** How `describe` names a provider of `providersOf`. */
function referenceOf(slot: ProviderSlot): ProviderReference {
	return { kind: "ref", key: slotEntry(slot).key };
}

const KIND_OF: Readonly<Record<ApplicationCollectionKey, string>> = {
	properties: "property",
	blueprints: "blueprint",
	records: "record",
	entities: "entity",
	environments: "environment",
	repositories: "repository",
	useCases: "use case",
	commands: "command",
	outputs: "output",
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

/** The application that declared each publisher of an application, by key. */
const publisherOrigins = new WeakMap<
	object,
	Readonly<Record<string, string>>
>();

/**
 * The publishers of an application: those of the applications it extends,
 * then its own, a later one winning a key; with the application that
 * declared each.
 */
function publishersOf(
	name: string,
	declared: unknown,
	extended: readonly AnyApplication[],
): {
	readonly publishers: Publishers;
	readonly origins: Record<string, string>;
} {
	const merged: Record<string, IEventPublisher> = {};
	const origins: Record<string, string> = {};
	for (const other of extended) {
		Object.assign(
			merged,
			(other as { readonly [ApplicationPublishersKey]?: Publishers })[
				ApplicationPublishersKey
			],
		);
		Object.assign(origins, publisherOrigins.get(other));
	}
	if (declared !== undefined) {
		if (
			typeof declared !== "object" ||
			declared === null ||
			Array.isArray(declared)
		) {
			invalid(
				name,
				"Expected `publishers` to be an object of publishers by key.",
			);
		}
		for (const [key, publisher] of Object.entries(declared)) {
			if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
				invalid(
					name,
					`Expected the publisher key "${key}" to be an identifier.`,
				);
			}
			if (!isEventPublisher(publisher)) {
				invalid(
					name,
					`Expected the publisher "${key}" to be an object with a publish(topic, event) method.`,
				);
			}
			merged[key] = publisher;
			origins[key] = name;
		}
	}
	return { publishers: Object.freeze(merged), origins };
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
		case "commands":
			return isCommand(value);
		case "outputs":
			return isOutput(value);
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
					: collection === "commands"
						? (value as AnyCommand).commandName
						: collection === "outputs"
							? (value as AnyOutput).outputName
							: collection === "exceptions"
								? (value as { name: string }).name
								: collection === "records" || collection === "entities"
									? // Only a name the class declares; the name of a class is free.
										(declaredRecordNameOf(value as object) ?? name)
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
	// The use cases a plugin made (`ctx.create(Posts)`) need no listing: the
	// commands that hold them register them, by name.
	for (const entry of [...registry.commands.values()]) {
		for (const UseCase of Object.values((entry.value as AnyCommand).useCases)) {
			if (useCaseOriginOf(UseCase) === undefined || byKey.has(UseCase)) {
				continue;
			}
			add({
				collection: "useCases",
				name: UseCase.useCaseName,
				value: UseCase,
				key: UseCase,
				from: entry.from,
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
						reference: `${isEntityClass(record) ? "entity" : "record"} "${recordNameOf(record as object)}"`,
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
					`the repository of "${recordNameOf((relation as { entity: object }).entity)}"`,
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

/** Checks that every use case of every command is registered. */
function validateCommands(source: string, registry: Registry): void {
	const useCases = new Set(
		[...registry.useCases.values()].map((entry) => entry.key),
	);
	const environments = new Set(
		[...registry.environments.values()].map((entry) => entry.key),
	);
	for (const entry of registry.commands.values()) {
		const command = entry.value as AnyCommand;
		for (const environment of command.environments) {
			if (environments.has(environment)) continue;
			throw new UnregisteredApplicationReference({
				source,
				details: {
					holder: `command "${entry.name}"`,
					reference: "an environment",
					command: entry.name,
				} as { holder: string; reference: string },
			});
		}
		for (const UseCase of Object.values(command.useCases)) {
			if (useCases.has(UseCase)) continue;
			throw new UnregisteredApplicationReference({
				source,
				details: {
					holder: `command "${entry.name}"`,
					reference: `use case "${UseCase.useCaseName}"`,
					command: entry.name,
					useCase: UseCase.useCaseName,
				} as { holder: string; reference: string },
			});
		}
	}
}

/** Checks that every output is named and every command of it is registered. */
function validateOutputs(source: string, registry: Registry): void {
	const commands = new Set(
		[...registry.commands.values()].map((entry) => entry.key),
	);
	for (const entry of registry.outputs.values()) {
		const output = entry.value as AnyOutput;
		if (!output.outputName) {
			invalid(
				source,
				`outputs.${entry.name} has no name (an output made by pipe cannot be registered).`,
			);
		}
		for (const command of output.commands) {
			if (commands.has(command)) continue;
			throw new UnregisteredApplicationReference({
				source,
				details: {
					holder: `output "${entry.name}"`,
					reference: `command "${command.commandName}"`,
					output: entry.name,
					command: command.commandName,
				} as { holder: string; reference: string },
			});
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
			// `Logger` is the core's own: nothing to register.
			const found = isLoggerDeclaration(dependency)
				? true
				: isUseCaseClass(dependency)
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
						reference: `${isEntityClass(record) ? "entity" : "record"} "${recordNameOf(record as object)}"`,
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
		for (const [index, step] of (interpretedStepsOf(UseCase) ?? []).entries()) {
			const holder = `step ${index} of use case "${entry.name}"`;
			if (step.build !== undefined && !registered.has(step.build as object)) {
				throw new UnregisteredApplicationReference({
					source,
					details: {
						holder,
						reference: `${isEntityClass(step.build) ? "entity" : "record"} "${recordNameOf(step.build as object)}"`,
					},
				});
			}
			const Thrown = step.error as
				| AnyUseCaseClass["errors"][number]
				| undefined;
			if (
				Thrown !== undefined &&
				!exceptions.has(Thrown) &&
				!isExportedException(Thrown)
			) {
				throw new UnregisteredApplicationReference({
					source,
					details: { holder, reference: `exception "${Thrown.name}"` },
				});
			}
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
			ref: ref ?? recordNameOf(record.record),
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
		for (const key of identityKeysOf(Record)) skip.add(key);
	}
	// Keys the options list on their own: not those a property or a plugin implies.
	const own = (keys: readonly string[], flag?: "sensitive" | "unique") =>
		keys.filter((key) => {
			if (skip.has(key)) return false;
			const field = Record.blueprint.properties[key];
			return !(flag && isProperty(field) && field.type[flag] === true);
		});
	const lifecycle =
		entry.collection === "entities" ? lifecycleEventsOf(Record) : {};
	const events = Object.fromEntries(
		Object.entries(lifecycle).map(([cycle, list]) => [
			cycle,
			list.map((event) => ({
				name: event.name,
				handler: eventHasHandler(event),
			})),
		]),
	);
	return {
		from: entry.from,
		fields: fieldsDescriptionOf(Record.blueprint.properties, scope, skip),
		options: {
			sensitive: own(Record.options.sensitive, "sensitive"),
			unique: own(Record.options.unique, "unique"),
			change: own(Record.options.change),
		},
		plugins,
		...(Object.keys(events).length > 0 ? { events } : {}),
		...(entry.collection === "entities" && isVersionedEntityClass(Record)
			? { versioned: true }
			: {}),
	};
}

function describeRegistry(
	name: string,
	extended: readonly AnyApplication[],
	registry: Registry,
	provider: ProviderDescription | ProviderReference | undefined,
	named: ReadonlyMap<string, NamedProvider>,
	log: Required<LogSettings> | "opaque" | undefined,
	publishers: Readonly<Record<string, string>>,
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
	const describeImplementation = (UseCase: AnyUseCaseClass) => {
		const steps = interpretedStepsOf(UseCase);
		return steps === undefined
			? ({ kind: "opaque" } as const)
			: ({
					kind: "steps",
					steps: describeSteps(steps, {
						record: (Class) =>
							(scope.entities.get(Class as object) ??
								scope.records.get(Class as object)) as string,
						error: (Class) => {
							const ref = exceptionRefs.get(Class as object);
							return ref === undefined
								? { core: (Class as { name: string }).name }
								: ref;
						},
					}),
				} as const);
	};
	// The classes among the options of a plugin, by name; the rest as it is.
	const describeOption = (value: unknown): unknown => {
		if (typeof value === "function") {
			if (isDeclaredException(value)) {
				return (
					exceptionRefs.get(value) ?? { core: (value as { name: string }).name }
				);
			}
			return (
				scope.entities.get(value) ??
				scope.records.get(value) ?? { kind: "opaque" }
			);
		}
		if (Array.isArray(value)) return value.map(describeOption);
		if (typeof value === "object" && value !== null) {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, item]) => item !== undefined)
					.map(([key, item]) => [key, describeOption(item)]),
			);
		}
		return value;
	};
	const describeGeneric = (
		UseCase: AnyUseCaseClass,
	): { generic?: NonNullable<UseCaseDescription["generic"]> } => {
		const origin = useCaseOriginOf(UseCase);
		// A class that extends one a plugin made and writes its own `execute`
		// is no longer what the plugin made.
		if (!origin || interpretedStepsOf(UseCase) === undefined) return {};
		const repository = repositories.get(
			(inspectRepository(origin.repository) as RepositoryInspection).state,
		);
		if (repository === undefined) return {};
		return {
			generic: {
				name: origin.plugin.name,
				version: origin.plugin.version,
				repository,
				options: describeOption(origin.options) as Readonly<
					Record<string, unknown>
				>,
			},
		};
	};
	// The names of the registered blueprints a use case or command is typed with.
	const refsOf = (
		blueprints: Record<string, AnyBlueprint | undefined>,
	): { refs?: Record<string, string> } => {
		const refs: Record<string, string> = {};
		for (const [key, blueprint] of Object.entries(blueprints)) {
			const ref =
				blueprint === undefined
					? undefined
					: scope.blueprints.get(blueprint.properties);
			if (ref !== undefined) refs[key] = ref;
		}
		return Object.keys(refs).length === 0 ? {} : { refs };
	};
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
		...(provider === undefined ? {} : { provider }),
		...(named.size === 0
			? {}
			: {
					providers: Object.fromEntries(
						[...named].map(([key, { slot, from }]) => {
							const { value } = slotEntry(slot);
							return [
								key,
								{
									from,
									...(isProviderFactory(value)
										? { kind: "opaque" as const }
										: providerDescriptionOf(value)),
								},
							];
						}),
					),
				}),
		...(log === undefined
			? {}
			: log === "opaque"
				? { log: { kind: "opaque" as const } }
				: {
						log: {
							level: log.level,
							providers: log.providers.map((logProvider) => {
								const providerName = logProviderNameOf(logProvider);
								return providerName === undefined
									? { kind: "opaque" as const }
									: { kind: "log-provider" as const, name: providerName };
							}),
						},
					}),
		...(Object.keys(publishers).length === 0
			? {}
			: {
					publishers: Object.fromEntries(
						Object.entries(publishers).map(([key, from]) => [key, { from }]),
					),
				}),
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
					: {
							provider: isProviderSlot(info.provider)
								? referenceOf(info.provider)
								: providerDescriptionOf(info.provider),
						}),
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
				...refsOf({
					input: UseCase.blueprint,
					response: UseCase.response,
					context: UseCase.context,
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
						isLoggerDeclaration(dependency)
							? { kind: "logger", ref: "Logger" }
							: isUseCaseClass(dependency)
								? {
										kind: "use-case",
										ref: useCaseRefs.get(dependency) as string,
									}
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
				implementation: describeImplementation(UseCase),
				...describeGeneric(UseCase),
			};
		}),
		commands: each("commands", (entry) => {
			const command = entry.value as AnyCommand;
			return {
				from: entry.from,
				name: command.commandName,
				...(command.description === undefined
					? {}
					: { description: command.description }),
				tags: command.tags,
				...(command.context === undefined
					? {}
					: {
							context: fieldsDescriptionOf(command.context.properties, scope),
						}),
				...refsOf({ context: command.context }),
				operations: Object.fromEntries(
					Object.entries(command.useCases).map(([op, UseCase]) => [
						op,
						{ ref: useCaseRefs.get(UseCase) as string },
					]),
				),
				transaction: command.transaction,
				...(command.environments.length === 0
					? {}
					: {
							environments: command.environments.map(
								(environment) => environmentRefs.get(environment) as string,
							),
						}),
				events:
					typeof command.events === "function"
						? (eventPolicyDescriptionOf(command.events) ??
							({ kind: "opaque" } as const))
						: command.events,
				...(command.onEventError === undefined
					? {}
					: { onEventError: { kind: "opaque" } as const }),
			};
		}),
		outputs: each("outputs", (entry) => {
			const output = entry.value as AnyOutput;
			return {
				from: entry.from,
				name: output.outputName,
				commands: output.commands.map((command) => command.commandName),
				statuses: output.statuses,
				pipe: output.stages.map((stage) => stageDescriptionOf(stage)),
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
	const Commands extends ApplicationCollections["commands"] = Record<
		never,
		never
	>,
	const Outputs extends ApplicationCollections["outputs"] = Record<
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
			commands: Commands;
			outputs: Outputs;
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
			commands: Commands;
			outputs: Outputs;
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
	validateCommands(name, registry);
	validateOutputs(name, registry);

	// The providers of `providersOf`, by key: those of the extended
	// applications (sharing their instances), then its own storage, whose
	// factories get instances of this application.
	if (
		settings.providers !== undefined &&
		!isProviderStorage(settings.providers)
	) {
		invalid(name, "Expected `providers` to be a storage made by providersOf.");
	}
	const named = new Map<string, NamedProvider>();
	const addNamed = (entry: NamedProvider) => {
		const { key } = slotEntry(entry.slot);
		const current = named.get(key);
		if (current !== undefined && current.slot !== entry.slot) {
			throw new ApplicationConflict({
				source: name,
				details: {
					reason: `The provider "${key}" is declared by different storages, in "${current.from}" and "${entry.from}".`,
					origins: [current.from, entry.from],
					declarations: [`provider ${key}`, `provider ${key}`],
				},
			});
		}
		named.set(key, entry);
	};
	for (const other of extended) {
		for (const entry of namedProviders.get(other)?.values() ?? []) {
			addNamed(entry);
		}
	}
	for (const slot of settings.providers ? slotsOf(settings.providers) : []) {
		const inherited = named.get(slotEntry(slot).key);
		if (inherited?.slot === slot) continue;
		const { value } = slotEntry(slot);
		addNamed({
			slot,
			from: name,
			instance: isProviderFactory(value)
				? deferredProvider(value, name)
				: value,
		});
	}
	const instances = new Map<object, IRepositoryProvider>(
		[...named.values()].map((entry) => [entry.slot, entry.instance]),
	);
	const instanceOf = (slot: ProviderSlot, holder: string) => {
		const instance = instances.get(slot);
		if (instance === undefined) {
			throw new UnregisteredApplicationReference({
				source: name,
				details: {
					holder,
					reference: `provider "${slotEntry(slot).key}"`,
				},
			});
		}
		return instance;
	};
	for (const entry of registry.repositories.values()) {
		const declared = (inspectRepository(entry.value) as RepositoryInspection)
			.provider;
		if (isProviderSlot(declared)) {
			instanceOf(declared, `repository "${entry.name}"`);
		}
	}

	const inheritedFrom =
		settings.provider === undefined
			? [...extended].reverse().find((other) => other.provider)
			: undefined;
	const declaredProvider: unknown =
		settings.provider ?? inheritedFrom?.provider;
	if (declaredProvider !== undefined && typeof declaredProvider !== "object") {
		invalid(name, "Expected `provider` to be a repository provider.");
	}
	const defaultSlot: ProviderSlot | undefined = isProviderSlot(declaredProvider)
		? declaredProvider
		: inheritedFrom === undefined
			? undefined
			: defaultSlots.get(inheritedFrom);
	// A provider of `providerFrom` is made on start: until then the
	// repositories are bound to one that forwards to it once it exists.
	const provider: IRepositoryProvider | undefined =
		defaultSlot !== undefined
			? instanceOf(defaultSlot, "the application")
			: isProviderFactory(declaredProvider)
				? deferredProvider(declaredProvider, name)
				: (declaredProvider as IRepositoryProvider | undefined);
	// Every provider it makes or closes: the default first, then the named ones.
	const allProviders = [
		...new Set(
			[provider, ...instances.values()].filter(
				(value): value is IRepositoryProvider => value !== undefined,
			),
		),
	];
	{
		const registered = new Set(
			[...registry.environments.values()].map((entry) => entry.key),
		);
		const holderOf = (instance: IRepositoryProvider) => {
			const entry = [...named.values()].find(
				(candidate) => candidate.instance === instance,
			);
			return entry === undefined || instance === provider
				? "the provider"
				: `provider "${slotEntry(entry.slot).key}"`;
		};
		for (const instance of allProviders) {
			for (const environment of deferredEnvironments(instance)) {
				if (registered.has(environment)) continue;
				throw new UnregisteredApplicationReference({
					source: name,
					details: {
						holder: holderOf(instance),
						reference: "an environment",
					},
				});
			}
		}
	}

	// The log: its own, else the one of the last extended application with one.
	const declaredLog: LogSettings | LogFactory | undefined =
		settings.log ??
		[...extended]
			.reverse()
			.map((other) => logSettings.get(other))
			.find((log) => log !== undefined);
	const log = declaredLog === undefined ? undefined : applicationLogger(name);
	// A `log` of `logFrom` is made on start; until then nothing is written.
	if (declaredLog !== undefined && !isLogFactory(declaredLog)) {
		log?.set(checkLogSettings(declaredLog));
	}
	const logger = log?.logger;
	const { publishers, origins } = publishersOf(
		name,
		settings.publishers,
		extended,
	);
	const hasPublishers = Object.keys(publishers).length > 0;
	for (const entry of registry.commands.values()) {
		for (const key of eventPolicyPublishersOf(
			(entry.value as AnyCommand).events,
		)) {
			if (!Object.hasOwn(publishers, key)) {
				throw new UnregisteredApplicationReference({
					source: name,
					details: {
						holder: `command "${entry.name}"`,
						reference: `publisher "${key}"`,
					},
				});
			}
		}
	}
	// Use cases, commands and outputs are rebound for a provider, a logger or
	// publishers. Repositories are bound for a provider, its own or one of `providersOf`.
	const bindsProviders = provider !== undefined || instances.size > 0;
	const rebinds = bindsProviders || logger !== undefined || hasPublishers;

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
		const repository = bindsProviders
			? bindRepository(entry.value as object, provider, instances)
			: entry.value;
		bound.set(entry.value, repository);
		boundByState.set(entry.key, repository);
		repositories[entry.name] = repository;
	}

	// A use case is bound once: a subclass whose dependencies are the bound
	// repositories and the bound use cases, never mutating the declared class.
	const boundUseCases = new Map<AnyUseCaseClass, AnyUseCaseClass>();
	const bindUseCase = (UseCase: AnyUseCaseClass): AnyUseCaseClass => {
		if (!rebinds) return UseCase;
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
					: isEnvironment(dependency) || isLoggerDeclaration(dependency)
						? dependency
						: (boundByState.get(
								(inspectRepository(dependency) as RepositoryInspection).state,
							) ?? dependency),
			]),
		);
		Object.defineProperty(Bound, "dependencies", {
			value: Object.freeze(dependencies),
		});
		if (logger)
			Object.defineProperty(Bound, ApplicationLoggerKey, { value: logger });
		return Bound as unknown as AnyUseCaseClass;
	};
	const useCases: Record<string, unknown> = {};
	const boundUseCaseOf = new Map<unknown, unknown>();
	for (const entry of registry.useCases.values()) {
		const bound = bindUseCase(entry.value as AnyUseCaseClass);
		boundUseCaseOf.set(entry.value, bound);
		useCases[entry.name] = bound;
	}

	// With a provider a command is rebuilt over the bound use cases, with the
	// same settings, and its transaction check runs now, on the bound providers.
	const commands: Record<string, unknown> = {};
	const boundCommandOf = new Map<unknown, unknown>();
	for (const entry of registry.commands.values()) {
		const declared = entry.value as AnyCommand;
		const rebuilt = !rebinds
			? declared
			: commandOf({
					name: declared.commandName,
					description: declared.description,
					tags: declared.tags,
					context: declared.context,
					useCases: Object.fromEntries(
						Object.entries(declared.useCases).map(([op, UseCase]) => [
							op,
							boundUseCaseOf.get(UseCase) as AnyUseCaseClass,
						]),
					),
					transaction: declared.transaction,
					environmentDependencies: declared.environments,
					events: declared.events,
					onEventError: declared.onEventError,
				} as never);
		if (bindsProviders) verifyCommand(rebuilt);
		if (hasPublishers) bindPublishers(rebuilt, publishers);
		boundCommandOf.set(entry.value, rebuilt);
		commands[entry.name] = rebuilt;
	}

	// With a provider an output is rebuilt over the bound commands, with the
	// same name, statuses and stages (the transforms run again on them).
	const outputs: Record<string, unknown> = {};
	const boundOutputOf = new Map<unknown, unknown>();
	for (const entry of registry.outputs.values()) {
		const declared = entry.value as AnyOutput;
		const rebuilt = !rebinds
			? declared
			: outputOf({
					name: declared.outputName,
					commands: declared.commands.map(
						(command) => boundCommandOf.get(command) as AnyCommand,
					),
					statuses: declared.statuses,
					pipe: declared.stages,
				});
		boundOutputOf.set(entry.value, rebuilt);
		outputs[entry.name] = rebuilt;
	}

	const environmentEntries = [...registry.environments.values()];
	const registeredEnvironments = new Set<unknown>(
		environmentEntries.map((entry) => entry.value),
	);
	const context: ApplicationContext = Object.freeze({
		name,
		env(environment: AnyEnvironment) {
			if (!registeredEnvironments.has(environment)) {
				throw new UnregisteredApplicationReference({
					source: name,
					details: { holder: "the context", reference: "an environment" },
				});
			}
			return environment.load();
		},
		logger: logger ?? silentLogger,
	}) as ApplicationContext;

	let starting: Promise<unknown> | undefined;
	let started = false;
	const start = async () => {
		// Every environment at once, so one start reports all that is missing.
		const failures: Record<string, string[]> = {};
		let cause: unknown;
		for (const entry of environmentEntries) {
			try {
				(entry.value as AnyEnvironment).load();
			} catch (error) {
				if (!(error instanceof Exception) || !error.is(InvalidEnvironment)) {
					throw error;
				}
				cause ??= error;
				failures[entry.name] = [
					...((error.details as { keys?: string[] } | undefined)?.keys ?? []),
				];
			}
		}
		if (Object.keys(failures).length > 0) {
			throw new InvalidApplicationEnvironment({
				source: name,
				details: { environments: failures },
				cause,
			});
		}
		// The log first, so that whoever makes the provider can log.
		if (isLogFactory(declaredLog)) {
			log?.set(checkLogSettings(await declaredLog.create(context)));
		}
		for (const instance of allProviders) {
			if (!isDeferredProvider(instance)) continue;
			const made = (await startDeferred(
				instance,
				context,
			)) as IRepositoryProvider;
			checkTransactions(
				name,
				made,
				Object.entries(commands)
					.filter(
						([, command]) =>
							(command as AnyCommand).transaction &&
							commandTransactionProvider(command as object) === instance,
					)
					.map(([key]) => key),
			);
		}
		started = true;
	};

	const application = Object.freeze({
		[Kind]: "application" as const,
		name,
		extends: Object.freeze([...extended]),
		provider,
		logger: logger ?? silentLogger,
		context,
		...(logger ? { [ApplicationLoggerKey]: logger } : {}),
		...(hasPublishers ? { [ApplicationPublishersKey]: publishers } : {}),
		properties: collection("properties"),
		blueprints: collection("blueprints"),
		records: collection("records"),
		entities: collection("entities"),
		environments: collection("environments"),
		repositories: Object.freeze(repositories),
		useCases: Object.freeze(useCases),
		commands: Object.freeze(commands),
		outputs: Object.freeze(outputs),
		exceptions: collection("exceptions"),
		useCase(useCase: unknown) {
			if (!boundUseCaseOf.has(useCase)) {
				invalid(name, "Expected a use case registered in the application.");
			}
			return boundUseCaseOf.get(useCase);
		},
		async run(
			useCase: unknown,
			input: unknown = {},
			options?: { readonly context?: unknown; readonly dependencies?: unknown },
		) {
			if (!boundUseCaseOf.has(useCase)) {
				invalid(name, "Expected a use case registered in the application.");
			}
			const Bound = boundUseCaseOf.get(useCase) as AnyUseCaseClass;
			const instance = (
				options?.context === undefined
					? new Bound(input)
					: new Bound(input, { context: options.context })
			) as { execute(dependencies?: unknown): Promise<unknown> };
			return instance.execute(options?.dependencies);
		},
		command(command: unknown) {
			if (!boundCommandOf.has(command)) {
				invalid(name, "Expected a command registered in the application.");
			}
			return boundCommandOf.get(command);
		},
		output(output: unknown) {
			if (!boundOutputOf.has(output)) {
				invalid(name, "Expected an output registered in the application.");
			}
			return boundOutputOf.get(output);
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
				...(provider === undefined
					? {}
					: { provider: defaultSlot ?? provider }),
				...(declaredLog === undefined ? {} : { log: declaredLog }),
			} as never);
		},
		describe: () =>
			describeRegistry(
				name,
				extended,
				registry,
				defaultSlot !== undefined
					? referenceOf(defaultSlot)
					: provider === undefined
						? undefined
						: providerDescriptionOf(provider),
				named,
				isLogFactory(declaredLog) ? "opaque" : log?.settings,
				origins,
			),
		get started() {
			return started;
		},
		start(options: { replace?: boolean; register?: boolean } = {}) {
			const { replace = false, register = true } = options ?? {};
			starting ??= (async () => {
				if (register) {
					const current = startedApplication();
					if (current !== undefined && current !== application) {
						if (!replace) {
							throw new ApplicationAlreadyStarted({
								source: name,
								details: { current: current.name, attempted: name },
							});
						}
						await current.stop();
					}
				}
				await start();
				if (register) setStartedApplication(application as never);
			})().then(
				() => application,
				async (error: unknown) => {
					starting = undefined;
					for (const instance of allProviders) {
						if (isDeferredProvider(instance)) await stopProvider(instance);
					}
					if (isLogFactory(declaredLog)) log?.set(undefined);
					throw error;
				},
			);
			return starting;
		},
		async stop() {
			const wasStarting = starting;
			starting = undefined;
			started = false;
			if (wasStarting) await wasStarting.catch(() => undefined);
			if (startedApplication() === application)
				setStartedApplication(undefined);
			for (const instance of allProviders) await stopProvider(instance);
			await log?.flush();
			if (isLogFactory(declaredLog)) log?.set(undefined);
		},
		get(declaration: unknown) {
			if (isEnvironment(declaration)) {
				if (!registeredEnvironments.has(declaration)) {
					invalid(
						name,
						"Expected an environment registered in the application.",
					);
				}
				return declaration.load();
			}
			if (isCommand(declaration)) return application.command(declaration);
			if (isOutput(declaration)) return application.output(declaration);
			if (isUseCaseClass(declaration)) return application.useCase(declaration);
			if (isRepository(declaration)) {
				return application.repository(declaration);
			}
			if (isProviderSlot(declaration)) {
				const instance = instances.get(declaration);
				if (instance === undefined) {
					invalid(
						name,
						"Expected a provider of a storage registered in the application.",
					);
				}
				return instance;
			}
			return invalid(
				name,
				"Expected a repository, use case, command, output, environment or provider registered in the application.",
			);
		},
	});
	internals.set(application, registry);
	namedProviders.set(application, named);
	if (defaultSlot !== undefined) defaultSlots.set(application, defaultSlot);
	if (declaredLog !== undefined) logSettings.set(application, declaredLog);
	publisherOrigins.set(application, Object.freeze(origins));
	return application as never;
}
