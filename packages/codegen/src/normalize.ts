import { catalog, recordPlugin } from "./catalog";
import { cyclesOf } from "./entity-events";
import { flagOf } from "./graph";
import { type Field, parseField } from "./model";
import { type Scope, scopeOf } from "./scope";
import { isObject } from "./spec/field";
import {
	COLLECTIONS,
	DEFAULT_OUTPUT_DIR,
	type FieldSpec,
	type ResolvedSpec,
	type Spec,
	type SpecIssue,
} from "./spec/types";
import { errorNameOf } from "./use-case";

type Json = Record<string, unknown>;

const parse = (value: unknown): Field | undefined => parseField(value, [], []);

/** A field in the canonical object form: only what is not a default. */
export function canonicalField(field: Field): Json {
	const base: Json =
		field.kind === "type"
			? {
					type: field.type,
					...(field.with && Object.keys(field.with).length > 0
						? { with: field.with }
						: {}),
				}
			: field.kind === "enum"
				? {
						enum: [...field.values],
						...(field.name === undefined ? {} : { name: field.name }),
						...(field.default === undefined ? {} : { default: field.default }),
					}
				: { fields: canonicalFields(field.fields) };
	return {
		...base,
		...(field.optional ? { optional: true } : {}),
		...(field.list ? { list: { ...field.list } } : {}),
	};
}

function canonicalFields(fields: Readonly<Record<string, Field>>): Json {
	return Object.fromEntries(
		Object.entries(fields).map(([key, field]) => [key, canonicalField(field)]),
	);
}

function fieldsOf(value: unknown): Json {
	if (!isObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, field]) => {
			const parsed = parse(field);
			return parsed ? [[key, canonicalField(parsed)]] : [];
		}),
	);
}

function keep(list: unknown): string[] | undefined {
	if (!Array.isArray(list)) return undefined;
	const unique = [...new Set(list.filter((item) => typeof item === "string"))];
	return unique.length > 0 ? unique : undefined;
}

function canonicalRecord(
	name: string,
	value: Json,
	entity: boolean,
	scope: Scope,
): Json {
	const fields = isObject(value.fields) ? value.fields : {};
	const plugins = keep(value.plugins);
	const pluginKeys = new Set(
		(plugins ?? []).flatMap((plugin) => recordPlugin(plugin)?.keys ?? []),
	);
	const identity = new Set<string>(entity ? catalog().identityKeys : []);
	const implied = (key: string, flag: "unique" | "sensitive") => {
		const parsed = parse(fields[key]);
		return parsed ? flagOf(parsed, flag, scope) : false;
	};
	const option = (
		key: "sensitive" | "unique" | "change",
	): string[] | undefined => {
		const list = keep(value[key])?.filter(
			(item) =>
				!pluginKeys.has(item) &&
				(key === "change" || !identity.has(item)) &&
				(key === "change" || !implied(item, key)),
		);
		return list && list.length > 0 ? list.sort() : undefined;
	};
	const [sensitive, unique, change] = [
		option("sensitive"),
		option("unique"),
		option("change"),
	];
	void name;
	// Events: a list per cycle, each a name or { name, handler }.
	const events = Object.fromEntries(
		Object.entries(entity ? cyclesOf(value.events) : {})
			.filter(([, list]) => list.length > 0)
			.map(([cycle, list]) => [
				cycle,
				list.map((entry) =>
					entry.handler === undefined
						? entry.name
						: { name: entry.name, handler: { import: entry.handler } },
				),
			]),
	);
	return {
		fields: fieldsOf(value.fields),
		...(sensitive ? { sensitive } : {}),
		...(unique ? { unique } : {}),
		...(change ? { change } : {}),
		...(plugins ? { plugins } : {}),
		...(Object.keys(events).length > 0 ? { events } : {}),
	};
}

function canonicalProperty(name: string, value: Json): Json {
	const optional = value.optional === true ? { optional: true } : {};
	if (value.opaque === true) {
		return {
			opaque: true,
			ref: typeof value.ref === "string" ? value.ref : name,
			import: value.import,
		};
	}
	if (Array.isArray(value.enum)) {
		return {
			enum: [...value.enum],
			...(value.name === undefined ? {} : { name: value.name }),
			...(value.default === undefined ? {} : { default: value.default }),
			...optional,
		};
	}
	return {
		base: value.base,
		...(isObject(value.with) && Object.keys(value.with).length > 0
			? { with: value.with }
			: {}),
		...optional,
	};
}

/**
 * A provider in its long form: `"inMemory"` is `{ use: "inMemory", options: {} }`.
 * A provider that is not declared stays undeclared: it is never the same as a shared one.
 */
function canonicalProvider(value: unknown): unknown {
	if (value === "inMemory") return { use: "inMemory", options: {} };
	if (isObject(value) && typeof value.use === "string") {
		return {
			use: value.use,
			options: isObject(value.options) ? value.options : {},
		};
	}
	return value;
}

/** The default message of a declared exception without one. */
export const defaultMessageOf = (name: string): string => `${name}.`;

function canonicalException(name: string, value: Json): Json {
	return {
		layer: value.layer,
		...(typeof value.message === "string" &&
		value.message !== defaultMessageOf(name)
			? { message: value.message }
			: {}),
	};
}

/** A blueprint reference as written: a name stays a name, fields get canonical. */
function canonicalBlueprintRef(value: unknown): unknown {
	return isObject(value) ? { fields: fieldsOf(value.fields) } : value;
}

function cloneJson<Value>(value: Value): Value {
	return JSON.parse(JSON.stringify(value)) as Value;
}

/** A core exception is `{ core }` in a step; a declared one is its name. */
function canonicalStep(step: unknown): unknown {
	if (!isObject(step)) return step;
	const copy = cloneJson(step) as Json;
	if (Object.hasOwn(copy, "ensure")) {
		const name = errorNameOf(copy.error);
		if (name !== undefined && catalog().coreExceptions.includes(name)) {
			copy.error = { core: name };
		}
	}
	return copy;
}

/** The options of a standard use case: core exceptions as `{ core }`, no `name`. */
function canonicalGenericOptions(options: Json): Json {
	const { name: _name, ...rest } = cloneJson(options) as Json;
	if (isObject(rest.errors)) {
		rest.errors = Object.fromEntries(
			Object.entries(rest.errors).map(([kind, error]) => {
				const name = errorNameOf(error);
				return [
					kind,
					name !== undefined && catalog().coreExceptions.includes(name)
						? { core: name }
						: error,
				];
			}),
		);
	}
	return rest;
}

function canonicalUseCase(value: Json): Json {
	const tags = keep(value.tags);
	if (typeof value.generic === "string") {
		const options = isObject(value.options)
			? canonicalGenericOptions(value.options)
			: undefined;
		return {
			generic: value.generic,
			repository: value.repository,
			...(options && Object.keys(options).length > 0 ? { options } : {}),
			...(typeof value.description === "string"
				? { description: value.description }
				: {}),
			...(tags ? { tags } : {}),
			...(value.deprecated === true ? { deprecated: true } : {}),
		};
	}
	const errors = keep(value.errors);
	const dependencies =
		isObject(value.dependencies) && Object.keys(value.dependencies).length > 0
			? { dependencies: { ...value.dependencies } }
			: {};
	const implementation = isObject(value.implementation)
		? Array.isArray(value.implementation.steps)
			? { steps: value.implementation.steps.map(canonicalStep) }
			: { ...value.implementation }
		: value.implementation;
	return {
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
		...(tags ? { tags } : {}),
		...(value.deprecated === true ? { deprecated: true } : {}),
		input: canonicalBlueprintRef(value.input),
		response: canonicalBlueprintRef(value.response),
		...(value.context === undefined
			? {}
			: { context: canonicalBlueprintRef(value.context) }),
		...dependencies,
		...(errors ? { errors } : {}),
		implementation,
	};
}

function canonicalCommand(value: Json): Json {
	const tags = keep(value.tags);
	return {
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
		...(tags ? { tags } : {}),
		...(value.context === undefined
			? {}
			: { context: canonicalBlueprintRef(value.context) }),
		useCases: isObject(value.useCases) ? { ...value.useCases } : value.useCases,
		...(value.transaction === true ? { transaction: true } : {}),
		...(Array.isArray(value.environments) && value.environments.length > 0
			? { environments: [...value.environments] }
			: {}),
		...(value.events !== undefined && value.events !== "after-commit"
			? { events: canonicalEvents(value.events) }
			: {}),
		...(value.onEventError === undefined
			? {}
			: { onEventError: cloneJson(value.onEventError) }),
	};
}

/** The events policy: a policy without options loses its empty `options`. */
function canonicalEvents(events: unknown): unknown {
	if (
		isObject(events) &&
		Object.hasOwn(events, "policy") &&
		isObject(events.options) &&
		Object.keys(events.options).length === 0
	) {
		return { policy: events.policy };
	}
	return cloneJson(events);
}

function canonicalPipeEntry(entry: unknown): unknown {
	if (!isObject(entry)) return entry;
	const kind = Object.hasOwn(entry, "sink") ? "sink" : "transform";
	if (!Object.hasOwn(entry, kind)) return cloneJson(entry);
	const options = entry.options;
	return {
		[kind]: entry[kind],
		...(isObject(options) && Object.keys(options).length > 0
			? { options: cloneJson(options) }
			: {}),
	};
}

function canonicalOutput(value: Json): Json {
	return {
		commands: Array.isArray(value.commands) ? [...value.commands] : [],
		...(isObject(value.statuses) && Object.keys(value.statuses).length > 0
			? { statuses: { ...value.statuses } }
			: {}),
		pipe: Array.isArray(value.pipe) ? value.pipe.map(canonicalPipeEntry) : [],
	};
}

const providerOf = (value: unknown): Json =>
	value === undefined ? {} : { provider: canonicalProvider(value) };

/**
 * The spec in a canonical form, where equivalent specs are equal: every field
 * in object form, defaults left out, `unique`/`sensitive` without what a
 * property or plugin already implies, and `output.dir` filled in. Two specs
 * that generate the same code have the same normalized form.
 */
export function normalizeSpec(
	input: Spec,
	extended: Readonly<Record<string, ResolvedSpec>> = {},
): Spec {
	const spec = input as unknown as Json;
	const sink: SpecIssue[] = [];
	const scope = scopeOf(spec, extended, sink);
	const out: Json = { version: 1 };
	if (typeof spec.name === "string") out.name = spec.name;
	if (Array.isArray(spec.extends) && spec.extends.length > 0) {
		out.extends = [...spec.extends];
	}
	out.output = {
		dir:
			isObject(spec.output) && typeof spec.output.dir === "string"
				? spec.output.dir
				: DEFAULT_OUTPUT_DIR,
	};
	Object.assign(out, providerOf(spec.provider));
	// Named providers in their long form, by key in order.
	if (isObject(spec.providers) && Object.keys(spec.providers).length > 0) {
		out.providers = Object.fromEntries(
			Object.keys(spec.providers)
				.sort()
				.map((key) => [key, canonicalProvider((spec.providers as Json)[key])]),
		);
	}
	// The level in full (info when omitted); an import stays as it is.
	if (isObject(spec.log)) {
		out.log = Object.hasOwn(spec.log, "import")
			? { ...spec.log }
			: {
					level: typeof spec.log.level === "string" ? spec.log.level : "info",
					providers: Array.isArray(spec.log.providers)
						? [...spec.log.providers]
						: [],
				};
	}
	// Publishers by key in order.
	if (isObject(spec.publishers) && Object.keys(spec.publishers).length > 0) {
		out.publishers = Object.fromEntries(
			Object.keys(spec.publishers)
				.sort()
				.map((key) => [key, cloneJson((spec.publishers as Json)[key])]),
		);
	}
	for (const collection of COLLECTIONS) {
		const declared = spec[collection];
		if (!isObject(declared)) continue;
		const entries = Object.entries(declared).filter(([, value]) =>
			isObject(value),
		) as [string, Json][];
		if (entries.length === 0) continue;
		out[collection] = Object.fromEntries(
			entries.map(([name, value]) => {
				switch (collection) {
					case "properties":
						return [name, canonicalProperty(name, value)];
					case "blueprints":
					case "environments":
						return [name, { fields: fieldsOf(value.fields) }];
					case "records":
					case "entities":
						return [
							name,
							canonicalRecord(name, value, collection === "entities", scope),
						];
					case "exceptions":
						return [name, canonicalException(name, value)];
					case "useCases":
						return [name, canonicalUseCase(value)];
					case "commands":
						return [name, canonicalCommand(value)];
					case "outputs":
						return [name, canonicalOutput(value)];
					default: {
						const relations = keep(value.relations);
						const environments = keep(value.environments);
						return [
							name,
							{
								entity: value.entity,
								actions: Array.isArray(value.actions) ? [...value.actions] : [],
								...providerOf(value.provider),
								...(value.deletion === "soft" ? { deletion: "soft" } : {}),
								...(relations ? { relations } : {}),
								...(environments ? { environments } : {}),
							},
						];
					}
				}
			}),
		);
	}
	return out as unknown as Spec;
}

function compactField(field: Json): FieldSpec {
	const { type, optional, list, ...rest } = field as {
		type?: string;
		optional?: boolean;
		list?: Json;
		[key: string]: unknown;
	};
	const bounded = isObject(list) && Object.keys(list).length > 0;
	if (typeof type === "string" && Object.keys(rest).length === 0 && !bounded) {
		return `${type}${list ? "[]" : ""}${optional ? "?" : ""}`;
	}
	if (isObject(rest.fields)) {
		rest.fields = Object.fromEntries(
			Object.entries(rest.fields).map(([key, inner]) => [
				key,
				compactField(inner as Json),
			]),
		);
	}
	return {
		...(type === undefined ? {} : { type }),
		...rest,
		...(optional ? { optional: true } : {}),
		...(list ? { list: bounded ? list : true } : {}),
	} as unknown as FieldSpec;
}

/** A provider in its shortest form: `"inMemory"`, or `{ use }` without empty options. */
function compactProvider(value: unknown): unknown {
	if (!isObject(value) || typeof value.use !== "string") return value;
	const empty =
		!isObject(value.options) || Object.keys(value.options).length === 0;
	if (!empty) return { use: value.use, options: value.options };
	return value.use === "inMemory" ? "inMemory" : { use: value.use };
}

/** A normalized spec with its fields in shorthand wherever the shorthand says the same. */
export function compactSpec(normalized: Spec): Spec {
	const spec = JSON.parse(JSON.stringify(normalized)) as Json;
	if (spec.provider !== undefined) {
		spec.provider = compactProvider(spec.provider);
	}
	if (isObject(spec.providers)) {
		for (const [key, value] of Object.entries(spec.providers)) {
			spec.providers[key] = compactProvider(value);
		}
	}
	if (isObject(spec.log) && spec.log.level === "info") {
		delete spec.log.level;
	}
	if (isObject(spec.repositories)) {
		for (const value of Object.values(spec.repositories)) {
			if (isObject(value) && value.provider !== undefined) {
				value.provider = compactProvider(value.provider);
			}
		}
	}
	const compactFields = (value: unknown): Json =>
		Object.fromEntries(
			Object.entries(isObject(value) ? value : {}).map(([key, field]) => [
				key,
				compactField(field as Json),
			]),
		);
	for (const collection of [
		"blueprints",
		"records",
		"entities",
		"environments",
	] as const) {
		const declared = spec[collection];
		if (!isObject(declared)) continue;
		for (const value of Object.values(declared)) {
			if (isObject(value)) value.fields = compactFields(value.fields);
		}
	}
	if (isObject(spec.commands)) {
		for (const value of Object.values(spec.commands)) {
			if (isObject(value) && isObject(value.context)) {
				value.context.fields = compactFields(value.context.fields);
			}
		}
	}
	if (isObject(spec.useCases)) {
		for (const value of Object.values(spec.useCases)) {
			if (!isObject(value)) continue;
			for (const key of ["input", "response", "context"]) {
				const ref = value[key];
				if (isObject(ref)) ref.fields = compactFields(ref.fields);
			}
		}
	}
	return spec as unknown as Spec;
}
