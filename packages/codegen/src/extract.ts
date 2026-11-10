import {
	type AnyApplication,
	type ApplicationDescription,
	type FieldDescription,
	type PropertyDescription,
	type PropertyReference,
	type ProviderDescription,
	type ProviderReference,
	Std,
} from "@afora/core";
import { genericUseCase, stdProperty } from "./catalog";
import type { Field } from "./model";
import { canonicalField, compactSpec } from "./normalize";
import { DEFAULT_OUTPUT_DIR, type Spec } from "./spec/types";

/** What `extractSpec` cannot know from an application. */
export interface ExtractOptions {
	/** The reference (relative path or package) of each extended application, by application name. The name itself by default. */
	readonly extends?: Readonly<Record<string, string>>;
	/** `output.dir` of the spec. `src/domain` by default. */
	readonly outputDir?: string;
	/**
	 * Where a property that cannot be recreated is imported from, by its name
	 * (`./opaque` by default). A provider created without `providerOf` cannot be
	 * described: it needs an entry `"./db.ts#provider"` under the key `provider`
	 * (the application's), `repositories.<Name>.provider` or `providers.<key>`
	 * (one of `providersOf`, e.g. made by `providerFrom`). A use case with a
	 * hand-written `execute` needs `useCases.<Name>`, a `run` function of a
	 * steps use case `useCases.<Name>.run.<name>`, the `before` and `after` of
	 * a standard use case `useCases.<Name>.before` and `.after`, a command with a handler
	 * `commands.<Name>.events` and `commands.<Name>.onEventError`, the handler of
	 * an entity event `entities.<Name>.events.<event>`, a publisher
	 * `publishers.<key>`, and a stage
	 * written by hand `outputs.<Name>.pipe.<index>`, all `"./file.ts#export"`.
	 */
	readonly imports?: Readonly<Record<string, string>>;
}

/** Thrown by `extractSpec` when the application holds something the spec cannot express without help. */
export class ExtractionError extends Error {
	override readonly name = "ExtractionError";
}

type Json = Record<string, unknown>;

const pascalOf = (text: string): string =>
	text
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("") || "Property";

/**
 * A provider as the spec says it. A named one (`providerOf`) is its name and
 * the JSON options it was given; an import reference that produced an option
 * cannot be recovered, so the options are those values.
 */
function providerSpec(
	description: ProviderDescription | ProviderReference,
	key: string,
	imports: Readonly<Record<string, string>> | undefined,
): unknown {
	// A provider of `providersOf`: its key.
	if (description.kind === "ref") return description.key;
	if (description.kind === "provider") {
		return description.name === "inMemory" &&
			Object.keys(description.options).length === 0
			? "inMemory"
			: {
					use: description.name,
					...(Object.keys(description.options).length > 0
						? { options: description.options }
						: {}),
				};
	}
	const reference = imports?.[key];
	if (reference === undefined) {
		throw new ExtractionError(
			`The provider of ${key === "provider" ? "the application" : key.startsWith("providers.") ? `the key "${key.slice("providers.".length)}" of providers` : `"${key.slice("repositories.".length, -".provider".length)}"`} was not created with providerOf, so it cannot be described. Create it with providerOf({ name, options, create }), or pass imports: { "${key}": "./path/to/file.ts#exportName" } to import it as it is.`,
		);
	}
	return { import: reference };
}

/**
 * The providers of `providersOf` the application registers itself (not
 * inherited ones), by key; one made by `providerFrom` needs an import in
 * `imports` (`"providers.<key>"`).
 */
function providersSpec(
	description: ApplicationDescription,
	imports: Readonly<Record<string, string>> | undefined,
): { providers?: Record<string, unknown> } {
	const own = Object.entries(description.providers ?? {}).filter(
		([, value]) => value.from === description.name,
	);
	if (own.length === 0) return {};
	return {
		providers: Object.fromEntries(
			own.map(([key, { from: _, ...value }]) => [
				key,
				providerSpec(value, `providers.${key}`, imports),
			]),
		),
	};
}

/**
 * The `log` as the spec says it: the built-in console and json providers by
 * name; any other provider, or a `log` of `logFrom`, needs an import in
 * `imports` (`"log"`, or `"log.providers.<index>"`).
 */
function logSpec(
	description: NonNullable<ApplicationDescription["log"]>,
	imports: Readonly<Record<string, string>> | undefined,
): unknown {
	if (!("level" in description)) {
		const reference = imports?.log;
		if (reference === undefined) {
			throw new ExtractionError(
				'The log of the application is made on start (logFrom), so it cannot be described. Pass imports: { "log": "./path/to/file.ts#exportName" } to import it as it is.',
			);
		}
		return { import: reference };
	}
	return {
		...(description.level === "info" ? {} : { level: description.level }),
		providers: description.providers.map((provider, index) => {
			if (
				provider.kind === "log-provider" &&
				(provider.name === "console" || provider.name === "json")
			) {
				return provider.name;
			}
			const key = `log.providers.${index}`;
			const reference = imports?.[key];
			if (reference === undefined) {
				throw new ExtractionError(
					`Log provider ${index} of the application is not "console" or "json", so the spec cannot name it. Pass imports: { "${key}": "./path/to/file.ts#exportName" } to import it as it is.`,
				);
			}
			return { import: reference };
		}),
	};
}

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
			...Object.keys(description.exceptions),
			...Object.keys(description.useCases),
			...Object.keys(description.commands),
			...Object.keys(description.outputs),
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

function importFor(
	imports: Readonly<Record<string, string>> | undefined,
	key: string,
	what: string,
): string {
	const reference = imports?.[key];
	if (reference === undefined) {
		throw new ExtractionError(
			`${what} cannot be described. Pass imports: { "${key}": "./path/to/file.ts#exportName" } to import it as it is.`,
		);
	}
	return reference;
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
		map: (value: Value, name: string) => Json,
	): Json =>
		Object.fromEntries(
			own(collection).map(([name, value]) => [name, map(value, name)]),
		);

	const blueprints = entries(description.blueprints, (value) => ({
		fields: extraction.json(value.fields),
	}));
	const records = entries(
		description.records,
		(value) => record(["", value])[1],
	);
	const entities = entries(description.entities, (value, name) => ({
		...(record(["", value])[1] as Record<string, unknown>),
		...(value.versioned === true ? { versioned: true } : {}),
		...(value.expires === undefined
			? {}
			: { expires: structuredClone(value.expires) as Json }),
		...(value.events === undefined
			? {}
			: {
					events: Object.fromEntries(
						Object.entries(value.events).map(([cycle, list]) => [
							cycle,
							(list ?? []).map((event) =>
								event.handler
									? {
											name: event.name,
											handler: {
												import: importFor(
													options.imports,
													`entities.${name}.events.${event.name}`,
													`The handler of the event "${event.name}" of the entity "${name}"`,
												),
											},
										}
									: event.name,
							),
						]),
					),
				}),
	}));
	const environments = entries(description.environments, (value) => ({
		fields: extraction.json(value.fields),
	}));
	const repositories = entries(description.repositories, (value, name) => ({
		entity: value.entity,
		actions: [...value.actions],
		...(value.provider === undefined
			? {}
			: {
					provider: providerSpec(
						value.provider,
						`repositories.${name}.provider`,
						options.imports,
					),
				}),
		...(value.deletion === "soft" ? { deletion: "soft" } : {}),
		...(value.relations.length > 0 ? { relations: [...value.relations] } : {}),
		...(value.environments.length > 0
			? { environments: [...value.environments] }
			: {}),
		...(Object.keys(value.indexes ?? {}).length > 0
			? {
					indexes: Object.fromEntries(
						Object.entries(value.indexes).map(([index, { where, orderBy }]) => [
							index,
							{
								where: [...where],
								...(orderBy === undefined ? {} : { orderBy }),
							},
						]),
					),
				}
			: {}),
		...(value.scans === "warn" || value.scans === "reject"
			? { scans: value.scans }
			: {}),
	}));

	const exceptions = entries(description.exceptions, (value, name) => ({
		layer: value.layer,
		// Declared with a function as its message: not recreated, so the default one is used.
		...(value.message === undefined || value.message === `${name}.`
			? {}
			: { message: value.message }),
	}));
	const useCases = entries(description.useCases, (value, name) => {
		// A standard use case is given back as it was asked for, not as its steps.
		// One made by a plugin of another catalog cannot be named in a spec:
		// it is described by its steps, as a use case written by hand.
		if (
			value.generic !== undefined &&
			genericUseCase(value.generic.name) !== undefined
		) {
			const {
				name: _name,
				description: _description,
				tags: _tags,
				deprecated: _deprecated,
				...given
			} = value.generic.options;
			const generic = structuredClone(given) as Record<string, unknown>;
			// The functions run before and after the write are imported as they are.
			for (const hook of ["before", "after"]) {
				if (generic[hook] !== undefined) {
					generic[hook] = {
						import: importFor(
							options.imports,
							`useCases.${name}.${hook}`,
							`The function "${hook}" of the standard use case "${name}"`,
						),
					};
				}
			}
			return {
				generic: value.generic.name,
				repository: value.generic.repository,
				...(Object.keys(generic).length > 0 ? { options: generic } : {}),
				...(value.description === undefined
					? {}
					: { description: value.description }),
				...(value.tags.length > 0 ? { tags: [...value.tags] } : {}),
				...(value.deprecated ? { deprecated: true } : {}),
			};
		}
		const steps =
			value.implementation.kind === "steps"
				? value.implementation.steps.map((step) => {
						if ("run" in step && "fn" in step) {
							const key = `useCases.${name}.run.${step.run}`;
							return {
								...step,
								fn: {
									import: importFor(
										options.imports,
										key,
										`The function of the step run "${step.run}" of the use case "${name}"`,
									),
								},
							};
						}
						return { ...step };
					})
				: undefined;
		return {
			...(value.description === undefined
				? {}
				: { description: value.description }),
			...(value.tags.length > 0 ? { tags: [...value.tags] } : {}),
			...(value.deprecated ? { deprecated: true } : {}),
			input: value.refs?.input ?? { fields: extraction.json(value.input) },
			response: value.refs?.response ?? {
				fields: extraction.json(value.response),
			},
			...(value.context === undefined
				? {}
				: {
						context: value.refs?.context ?? {
							fields: extraction.json(value.context),
						},
					}),
			...(Object.keys(value.dependencies).length > 0
				? {
						dependencies: Object.fromEntries(
							Object.entries(value.dependencies).map(([key, dep]) => [
								key,
								dep.ref,
							]),
						),
					}
				: {}),
			...(value.errors.length > 0
				? {
						errors: value.errors.map((error) =>
							error.kind === "core" ? error.name : error.ref,
						),
					}
				: {}),
			implementation: steps
				? { steps }
				: {
						import: importFor(
							options.imports,
							`useCases.${name}`,
							`The use case "${name}" has a hand-written execute, so it`,
						),
					},
		};
	});

	const commands = entries(description.commands, (value, name) => ({
		...(value.description === undefined
			? {}
			: { description: value.description }),
		...(value.tags.length > 0 ? { tags: [...value.tags] } : {}),
		...(value.context === undefined
			? {}
			: {
					context: value.refs?.context ?? {
						fields: extraction.json(value.context),
					},
				}),
		useCases: Object.fromEntries(
			Object.entries(value.operations).map(([op, operation]) => [
				op,
				operation.ref,
			]),
		),
		...(value.transaction ? { transaction: true } : {}),
		...(value.environments && value.environments.length > 0
			? { environments: [...value.environments] }
			: {}),
		...(value.events === "after-commit"
			? {}
			: {
					events:
						value.events === "manual"
							? "manual"
							: value.events.kind === "policy"
								? {
										policy: value.events.name,
										...(Object.keys(value.events.options).length > 0
											? { options: structuredClone(value.events.options) }
											: {}),
									}
								: {
										import: importFor(
											options.imports,
											`commands.${name}.events`,
											`The events handler of the command "${name}"`,
										),
									},
				}),
		...(value.onEventError === undefined
			? {}
			: {
					onEventError: {
						import: importFor(
							options.imports,
							`commands.${name}.onEventError`,
							`The onEventError handler of the command "${name}"`,
						),
					},
				}),
	}));
	const outputs = entries(description.outputs, (value, name) => ({
		commands: [...value.commands],
		...(Object.keys(value.statuses).length > 0
			? { statuses: { ...value.statuses } }
			: {}),
		pipe: value.pipe.map((stage, index) => {
			if (stage.kind === "opaque") {
				return {
					import: importFor(
						options.imports,
						`outputs.${name}.pipe.${index}`,
						`The stage ${index} of the output "${name}" was written by hand, so it`,
					),
				};
			}
			return {
				[stage.kind]: stage.name,
				...(Object.keys(stage.options).length > 0
					? { options: JSON.parse(JSON.stringify(stage.options)) }
					: {}),
			};
		}),
	}));

	const allProperties = { ...extraction.generated, ...properties };
	// Its own publishers: inherited ones belong to the spec it extends.
	const publishers = Object.fromEntries(
		Object.entries(description.publishers ?? {})
			.filter(([, { from }]) => from === description.name)
			.map(([key]) => [
				key,
				{
					import: importFor(
						options.imports,
						`publishers.${key}`,
						`The publisher "${key}"`,
					),
				},
			]),
	);
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
		...(description.provider === undefined
			? {}
			: {
					provider: providerSpec(
						description.provider,
						"provider",
						options.imports,
					),
				}),
		...providersSpec(description, options.imports),
		...(description.log === undefined
			? {}
			: { log: logSpec(description.log, options.imports) }),
		...(Object.keys(publishers).length > 0 ? { publishers } : {}),
		...(Object.keys(allProperties).length > 0
			? { properties: allProperties }
			: {}),
		...(Object.keys(blueprints).length > 0 ? { blueprints } : {}),
		...(Object.keys(records).length > 0 ? { records } : {}),
		...(Object.keys(entities).length > 0 ? { entities } : {}),
		...(Object.keys(environments).length > 0 ? { environments } : {}),
		...(Object.keys(repositories).length > 0 ? { repositories } : {}),
		...(Object.keys(exceptions).length > 0 ? { exceptions } : {}),
		...(Object.keys(useCases).length > 0 ? { useCases } : {}),
		...(Object.keys(commands).length > 0 ? { commands } : {}),
		...(Object.keys(outputs).length > 0 ? { outputs } : {}),
	};
	return compactSpec(spec as unknown as Spec);
}
