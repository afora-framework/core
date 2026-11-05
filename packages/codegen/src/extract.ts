import {
	type AnyApplication,
	type ApplicationDescription,
	type FieldDescription,
	type PropertyDescription,
	type PropertyReference,
	Std,
} from "@afora/core";
import { stdProperty } from "./catalog";
import type { Field } from "./model";
import { canonicalField, compactSpec } from "./normalize";
import { DEFAULT_OUTPUT_DIR, type Spec } from "./spec/types";

/** What `extractSpec` cannot know from an application. */
export interface ExtractOptions {
	/** The reference (relative path or package) of each extended application, by application name. The name itself by default. */
	readonly extends?: Readonly<Record<string, string>>;
	/** `output.dir` of the spec. `src/domain` by default. */
	readonly outputDir?: string;
	/** Where a property that cannot be recreated is imported from, by its name. `./opaque` by default. */
	readonly imports?: Readonly<Record<string, string>>;
}

type Json = Record<string, unknown>;

const pascalOf = (text: string): string =>
	text
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("") || "Property";

class Extraction {
	readonly opaque = new Map<string, string>();
	readonly declared: Set<string>;
	readonly generated: Record<string, Json> = {};

	constructor(
		readonly description: ApplicationDescription,
		readonly options: ExtractOptions,
	) {
		this.declared = new Set([
			...Object.keys(description.properties),
			...Object.keys(description.blueprints),
			...Object.keys(description.records),
			...Object.keys(description.entities),
			...Object.keys(description.environments),
			...Object.keys(description.repositories),
		]);
	}

	/** A property that is registered nowhere and is not a Std one: declared as an opaque import. */
	opaqueFor(property: PropertyDescription): Field {
		const key = `${property.name}`;
		let name = this.opaque.get(key);
		if (!name) {
			name = pascalOf(property.name);
			while (this.declared.has(name)) name = `${name}Property`;
			this.declared.add(name);
			this.opaque.set(key, name);
			this.generated[name] = {
				opaque: true,
				ref: name,
				import: this.options.imports?.[property.name] ?? "./opaque",
			};
		}
		return { kind: "type", type: name, optional: false };
	}

	property(property: PropertyReference): Field {
		if (!("name" in property)) {
			return { kind: "type", type: property.ref, optional: false };
		}
		const { lineage } = property;
		if (!lineage) {
			return Object.hasOwn(Std.properties, property.name) &&
				stdProperty(property.name)?.usable
				? { kind: "type", type: property.name, optional: false }
				: this.opaqueFor(property);
		}
		switch (lineage.kind) {
			case "refined": {
				const inner = this.property(lineage.base);
				if (inner.kind !== "type") return this.opaqueFor(property);
				return {
					...inner,
					with: { ...(inner.with ?? {}), ...lineage.options },
				};
			}
			case "optional":
				return { ...this.property(lineage.base), optional: true };
			case "factory": {
				if (lineage.factory !== "enumOf") return this.opaqueFor(property);
				const {
					values,
					name,
					optional,
					default: fallback,
				} = lineage.args as {
					values: (string | number)[];
					name?: string;
					optional?: boolean;
					default?: string | number;
				};
				return {
					kind: "enum",
					values,
					optional: optional === true,
					...(name === undefined ? {} : { name }),
					...(fallback === undefined ? {} : { default: fallback }),
				};
			}
		}
	}

	field(field: FieldDescription): Field {
		switch (field.kind) {
			case "property": {
				if ("ref" in field) {
					const declared = this.description.properties[field.ref];
					const optional = !!(field.optional && declared?.optional !== true);
					return { kind: "type", type: field.ref, optional };
				}
				return this.property(field);
			}
			case "list": {
				const item = this.field(field.item);
				return {
					...item,
					optional: field.optional,
					list: {
						...(field.minItems === undefined
							? {}
							: { minItems: field.minItems }),
						...(field.maxItems === undefined
							? {}
							: { maxItems: field.maxItems }),
					},
				};
			}
			case "blueprint":
				return "ref" in field
					? { kind: "type", type: field.ref, optional: field.optional }
					: {
							kind: "inline",
							optional: field.optional,
							fields: this.fields(field.fields),
						};
			default:
				return { kind: "type", type: field.ref, optional: field.optional };
		}
	}

	fields(
		fields: Readonly<Record<string, FieldDescription>>,
	): Record<string, Field> {
		return Object.fromEntries(
			Object.entries(fields).map(([key, field]) => [key, this.field(field)]),
		);
	}

	json(fields: Readonly<Record<string, FieldDescription>>): Json {
		return Object.fromEntries(
			Object.entries(this.fields(fields)).map(([key, field]) => [
				key,
				canonicalField(field),
			]),
		);
	}

	propertyDeclaration(name: string, property: PropertyDescription): Json {
		if (!property.lineage) {
			if (Object.hasOwn(Std.properties, property.name)) {
				return { base: property.name };
			}
			return {
				opaque: true,
				ref: name,
				import: this.options.imports?.[name] ?? "./opaque",
			};
		}
		const field = this.property(property);
		if (field.kind === "type") {
			return {
				base: field.type,
				...(field.with && Object.keys(field.with).length > 0
					? { with: field.with }
					: {}),
				...(field.optional ? { optional: true } : {}),
			};
		}
		if (field.kind === "enum") {
			return {
				enum: [...field.values],
				...(field.name === undefined ? {} : { name: field.name }),
				...(field.default === undefined ? {} : { default: field.default }),
				...(field.optional ? { optional: true } : {}),
			};
		}
		return {
			opaque: true,
			ref: name,
			import: this.options.imports?.[name] ?? "./opaque",
		};
	}
}

/**
 * The `afora.json` of an application: the inverse of `generate`. Only the
 * declarations the application registered itself are included; those it
 * inherits come back as `extends`. A property that cannot be recreated (a
 * custom `propertyOf`) becomes an opaque import. The fields are in
 * shorthand where it says the same.
 */
export function extractSpec(
	app: AnyApplication,
	options: ExtractOptions = {},
): Spec {
	const description = app.describe();
	const extraction = new Extraction(description, options);
	const own = <Value extends { readonly from: string }>(
		collection: Readonly<Record<string, Value>>,
	): [string, Value][] =>
		Object.entries(collection).filter(
			([, value]) => value.from === description.name,
		);

	const properties = Object.fromEntries(
		own(description.properties).map(([name, property]) => [
			name,
			extraction.propertyDeclaration(name, property),
		]),
	);
	const record = ([, value]: [string, (typeof description.records)[string]]) =>
		[
			value,
			{
				fields: extraction.json(value.fields),
				...(value.options.sensitive.length > 0
					? { sensitive: [...value.options.sensitive] }
					: {}),
				...(value.options.unique.length > 0
					? { unique: [...value.options.unique] }
					: {}),
				...(value.options.change.length > 0
					? { change: [...value.options.change] }
					: {}),
				...(value.plugins.length > 0
					? { plugins: value.plugins.map((plugin) => plugin.name) }
					: {}),
			},
		] as const;
	const entries = <Value extends { readonly from: string }>(
		collection: Readonly<Record<string, Value>>,
		map: (value: Value) => Json,
	): Json =>
		Object.fromEntries(
			own(collection).map(([name, value]) => [name, map(value)]),
		);

	const blueprints = entries(description.blueprints, (value) => ({
		fields: extraction.json(value.fields),
	}));
	const records = entries(
		description.records,
		(value) => record(["", value])[1],
	);
	const entities = entries(
		description.entities,
		(value) => record(["", value])[1],
	);
	const environments = entries(description.environments, (value) => ({
		fields: extraction.json(value.fields),
	}));
	const repositories = entries(description.repositories, (value) => ({
		entity: value.entity,
		actions: [...value.actions],
		...(value.relations.length > 0 ? { relations: [...value.relations] } : {}),
		...(value.environments.length > 0
			? { environments: [...value.environments] }
			: {}),
	}));

	const allProperties = { ...extraction.generated, ...properties };
	const spec: Json = {
		version: 1,
		name: description.name,
		...(description.extends.length > 0
			? {
					extends: description.extends.map(
						(name) => options.extends?.[name] ?? name,
					),
				}
			: {}),
		output: { dir: options.outputDir ?? DEFAULT_OUTPUT_DIR },
		...(Object.keys(allProperties).length > 0
			? { properties: allProperties }
			: {}),
		...(Object.keys(blueprints).length > 0 ? { blueprints } : {}),
		...(Object.keys(records).length > 0 ? { records } : {}),
		...(Object.keys(entities).length > 0 ? { entities } : {}),
		...(Object.keys(environments).length > 0 ? { environments } : {}),
		...(Object.keys(repositories).length > 0 ? { repositories } : {}),
	};
	return compactSpec(spec as unknown as Spec);
}
