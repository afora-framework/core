import { catalog, recordPlugin } from "./catalog";
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
	return {
		fields: fieldsOf(value.fields),
		...(sensitive ? { sensitive } : {}),
		...(unique ? { unique } : {}),
		...(change ? { change } : {}),
		...(plugins ? { plugins } : {}),
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
					default: {
						const relations = keep(value.relations);
						const environments = keep(value.environments);
						return [
							name,
							{
								entity: value.entity,
								actions: Array.isArray(value.actions) ? [...value.actions] : [],
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

/** A normalized spec with its fields in shorthand wherever the shorthand says the same. */
export function compactSpec(normalized: Spec): Spec {
	const spec = JSON.parse(JSON.stringify(normalized)) as Json;
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
	return spec as unknown as Spec;
}
