import { catalog, identityKeysOf, recordPlugin } from "./catalog";
import { checkCommand } from "./command";
import { checkEntityEvents } from "./entity-events";
import { checkEntityExpires } from "./entity-expires";
import { checkEntitySchema } from "./entity-schema";
import { fieldsOfDecl, flagOf, orderOf, type Root, rootOf } from "./graph";
import { checkEnum, type Field, parseFields, targetOf } from "./model";
import { checkOutput, checkStageCatalog, stageEntries } from "./output";
import { checkPolicyCatalog, checkPublishers, policyEntries } from "./policy";
import {
	checkCatalog,
	checkLog,
	checkProvider,
	checkProviders,
	checkTrace,
} from "./provider";
import {
	checkEnvironmentNames,
	type Decl,
	issue,
	type Scope,
	scopeOf,
	usableProviderKeys,
} from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import {
	COLLECTIONS,
	type CodegenOptions,
	type EventPolicyCatalogEntry,
	KIND_OF,
	type ProviderCatalogEntry,
	type ResolvedSpec,
	type SpecIssue,
	type StageCatalogEntry,
} from "./spec/types";
import { checkException, checkUseCase } from "./use-case";

const TOP_LEVEL_KEYS = [
	"$schema",
	"version",
	"name",
	"extends",
	"output",
	"provider",
	"providers",
	"log",
	"trace",
	"publishers",
	...COLLECTIONS,
];

type Path = readonly (string | number)[];

const METADATA_TYPES: Readonly<Record<string, string>> = {
	title: "string",
	description: "string",
	deprecated: "boolean",
	readOnly: "boolean",
	writeOnly: "boolean",
};

/** Checks `with` against the properties it applies to. */
function checkWith(
	options: Readonly<Record<string, unknown>>,
	root: Root | undefined,
	path: Path,
	issues: SpecIssue[],
): void {
	if (root === undefined) return;
	if (root.kind === "opaque") {
		issues.push(
			issue(
				path,
				"invalid_with",
				'"with" cannot refine an opaque property: its options are not known.',
			),
		);
		return;
	}
	const allowed =
		root.kind === "std"
			? root.info.options
			: [
					"title",
					"description",
					"examples",
					"deprecated",
					"readOnly",
					"writeOnly",
					"default",
				];
	const kind = root.kind === "std" ? root.info.schemaType : "enum";
	for (const [key, value] of Object.entries(options)) {
		const here = [...path, key];
		if (!allowed.includes(key)) {
			issues.push(
				issue(
					here,
					"invalid_with",
					`"${key}" is not an option of ${root.kind === "std" ? `"${root.info.name}" (a ${kind} property)` : "an enum"}. Valid options: ${allowed.join(", ")}.`,
				),
			);
			continue;
		}
		const wanted = METADATA_TYPES[key];
		if (wanted !== undefined) {
			if (typeof value !== wanted) {
				issues.push(
					issue(here, "invalid_with", `"${key}" must be a ${wanted}.`),
				);
			}
		} else if (key === "examples") {
			if (!Array.isArray(value)) {
				issues.push(
					issue(here, "invalid_with", '"examples" must be an array.'),
				);
			}
		} else if (key === "pattern") {
			let valid = typeof value === "string";
			if (valid) {
				try {
					new RegExp(value as string);
				} catch {
					valid = false;
				}
			}
			if (!valid) {
				issues.push(
					issue(
						here,
						"invalid_with",
						'"pattern" must be a valid regular expression, as a string.',
					),
				);
			}
		} else if (key === "min" || key === "max") {
			const lengthLike = kind === "string";
			const ok =
				typeof value === "number" &&
				Number.isFinite(value) &&
				(!lengthLike || (Number.isInteger(value) && value >= 0));
			if (!ok) {
				issues.push(
					issue(
						here,
						"invalid_with",
						lengthLike
							? `"${key}" is a length: a non-negative integer.`
							: `"${key}" must be a number.`,
					),
				);
			}
		} else if (key === "exclusiveMin" || key === "exclusiveMax") {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				issues.push(issue(here, "invalid_with", `"${key}" must be a number.`));
			}
		} else if (key === "multipleOf") {
			if (typeof value !== "number" || !(value > 0)) {
				issues.push(
					issue(
						here,
						"invalid_with",
						'"multipleOf" must be a number greater than 0.',
					),
				);
			}
		}
		// "default" is the demo value of the property: any JSON value.
	}
	const bound = (key: string) =>
		typeof options[key] === "number" ? (options[key] as number) : undefined;
	const [min, max] = [bound("min"), bound("max")];
	if (min !== undefined && max !== undefined && min > max) {
		issues.push(
			issue(path, "invalid_with", '"min" cannot be greater than "max".'),
		);
	}
}

type OwnerKind = "blueprint" | "record" | "entity" | "environment" | "inline";

/** Checks the semantics of one parsed field: its type, its options and, for inline fields, its keys. */
function checkField(
	field: Field,
	path: Path,
	scope: Scope,
	owner: OwnerKind,
	issues: SpecIssue[],
): void {
	if (owner === "environment" && field.list) {
		issues.push(
			issue(
				path,
				"invalid_environment_field",
				"An environment variable cannot be a list.",
			),
		);
	}
	if (field.kind === "enum") return;
	if (field.kind === "inline") {
		if (owner === "environment") {
			issues.push(
				issue(
					path,
					"invalid_environment_field",
					"An environment variable is a property, not an object.",
				),
			);
			return;
		}
		checkKeys(field.fields, [...path, "fields"], "inline", issues);
		for (const [key, inner] of Object.entries(field.fields)) {
			checkField(inner, [...path, "fields", key], scope, "inline", issues);
		}
		return;
	}
	if (field.kind === "variant") {
		checkVariant(field, path, scope, owner, issues);
		return;
	}
	const target = targetOf(field.type, scope);
	const typePath = [...path, "type"];
	if (!target) {
		issues.push(
			issue(
				/^[a-z]/.test(field.type) ? typePath : typePath,
				"unknown_type",
				/^[a-z]/.test(field.type)
					? `"${field.type}" is not a Std property. Available: ${catalog()
							.properties.filter((property) => property.usable)
							.map((property) => property.name)
							.join(", ")}.`
					: `"${field.type}" is not declared in this spec (or the specs it extends). Declare it under properties, blueprints, records or entities.`,
			),
		);
		return;
	}
	if (target.kind === "std") {
		const info = catalog().properties.find((p) => p.name === target.name);
		if (!info) {
			issues.push(
				issue(
					typePath,
					"unknown_type",
					`"${field.type}" is not a Std property. Available: ${catalog()
						.properties.filter((property) => property.usable)
						.map((property) => property.name)
						.join(", ")}.`,
				),
			);
			return;
		}
		if (!info.usable) {
			issues.push(
				issue(
					typePath,
					"unusable_type",
					`"${field.type}" needs a TypeBox schema, which JSON cannot carry. Declare an opaque property that imports it.`,
				),
			);
			return;
		}
	} else {
		const { kind } = target.decl;
		const allowed =
			owner === "environment"
				? ["property"]
				: ["property", "blueprint", "record", "entity"];
		if (!allowed.includes(kind)) {
			issues.push(
				issue(
					typePath,
					"wrong_kind",
					`"${field.type}" is a ${kind}, which a field of ${owner === "environment" ? "an environment" : "this kind"} cannot have. ${owner === "environment" ? "An environment holds properties only." : "Use a property, a blueprint, a record or an entity."}`,
				),
			);
			return;
		}
	}
	if (field.with) {
		const root = rootOf(field.type, scope);
		if (target.kind === "decl" && target.decl.kind !== "property") {
			issues.push(
				issue(
					[...path, "with"],
					"invalid_with",
					`"with" applies to properties; "${field.type}" is a ${target.decl.kind}.`,
				),
			);
		} else {
			checkWith(field.with, root, [...path, "with"], issues);
		}
	}
}

/**
 * Checks a variant field: each variant is a declared blueprint, record or
 * entity (a class names one variant only) or a blueprint declared in place,
 * and none declares the key, which the field adds.
 */
function checkVariant(
	field: Extract<Field, { kind: "variant" }>,
	path: Path,
	scope: Scope,
	owner: OwnerKind,
	issues: SpecIssue[],
): void {
	if (owner === "environment") {
		issues.push(
			issue(
				path,
				"invalid_environment_field",
				"An environment variable is a property, not one of several objects.",
			),
		);
		return;
	}
	const classes = new Map<string, string>();
	for (const [tag, target] of Object.entries(field.variants)) {
		const here = [...path, "variant", "of", tag];
		let keys: string[];
		if ("fields" in target) {
			checkKeys(target.fields, [...here, "fields"], "inline", issues);
			for (const [key, inner] of Object.entries(target.fields)) {
				checkField(inner, [...here, "fields", key], scope, "inline", issues);
			}
			keys = Object.keys(target.fields);
		} else {
			const decl = scope.decls.get(target.type);
			if (!decl) {
				issues.push(
					issue(
						here,
						"unknown_type",
						`"${target.type}" is not declared in this spec (or the specs it extends). Declare it under blueprints, records or entities.`,
					),
				);
				continue;
			}
			if (
				decl.kind !== "blueprint" &&
				decl.kind !== "record" &&
				decl.kind !== "entity"
			) {
				issues.push(
					issue(
						here,
						"wrong_kind",
						`"${target.type}" is a ${decl.kind}; a variant is a blueprint, a record or an entity.`,
					),
				);
				continue;
			}
			if (decl.kind !== "blueprint") {
				const other = classes.get(decl.name);
				if (other !== undefined) {
					issues.push(
						issue(
							here,
							"invalid_variant",
							`"${target.type}" is already the variant "${other}": a record or an entity is told apart by its class, so it names one variant only.`,
						),
					);
				} else classes.set(decl.name, tag);
			}
			keys =
				decl.kind === "blueprint"
					? Object.keys(fieldsOfDecl(decl) ?? {})
					: keysOf(decl);
		}
		if (keys.includes(field.key)) {
			issues.push(
				issue(
					[...path, "variant", "key"],
					"invalid_variant",
					`The variant "${tag}" declares "${field.key}", which the field adds with the name of the variant for its value. Rename the key or the field of the variant.`,
				),
			);
		}
	}
}

function checkKeys(
	fields: Readonly<Record<string, unknown>>,
	path: Path,
	owner: OwnerKind,
	issues: SpecIssue[],
	identity: readonly string[] = catalog().identityKeys,
): void {
	const entries = catalog();
	for (const key of Object.keys(fields)) {
		const here = [...path, key];
		if (!isIdentifier(key)) {
			issues.push(
				issue(
					here,
					"invalid_key",
					`"${key}" is not a valid key: use letters, digits, "_" or "$", not starting with a digit.`,
				),
			);
			continue;
		}
		if (owner === "entity" && identity.includes(key)) {
			issues.push(
				issue(
					here,
					"identity_key",
					`"${key}" is part of every entity's identity (${identity.join(", ")}) and is added by entityOf; remove it from the fields.`,
				),
			);
			continue;
		}
		const reserved = [
			...(owner === "record" || owner === "entity"
				? entries.reservedRecordKeys
				: []),
			...(owner === "entity" ? entries.reservedEntityKeys : []),
		];
		if (reserved.includes(key)) {
			issues.push(
				issue(
					here,
					"reserved_key",
					`"${key}" is reserved (a member of every ${owner}); rename the field.`,
				),
			);
		}
	}
}

/** The names of the keys a plugin list adds, for the plugins that exist. */
function pluginKeysOf(spec: Record<string, unknown>): string[] {
	if (!Array.isArray(spec.plugins)) return [];
	return spec.plugins.flatMap((name) =>
		typeof name === "string" ? (recordPlugin(name)?.keys ?? []) : [],
	);
}

/** All keys of a record or entity declaration: fields, plugin keys and, for an entity, identity. */
function keysOf(decl: Decl): string[] {
	const fields = fieldsOfDecl(decl) ?? {};
	return [
		...(decl.kind === "entity" ? identityKeysOf(decl.spec) : []),
		...Object.keys(fields),
		...pluginKeysOf(decl.spec),
	];
}

/** The unique keys of an entity: `id`, `unique`, unique properties and unique keys of plugins. */
/** The keys of the `change` list of `decl` that hold a number (not a list), which `increment` takes. */
function numericChangeKeysOf(decl: Decl, scope: Scope): string[] {
	const fields = fieldsOfDecl(decl) ?? {};
	const change = Array.isArray(decl.spec.change) ? decl.spec.change : [];
	return change.filter((key): key is string => {
		if (typeof key !== "string") return false;
		const field = fields[key];
		if (field?.kind !== "type" || field.list) return false;
		const root = rootOf(field.type, scope);
		return (
			root?.kind === "std" &&
			(root.info.schemaType === "number" || root.info.schemaType === "integer")
		);
	});
}

function uniqueKeysOf(decl: Decl, scope: Scope): Set<string> {
	const unique = new Set<string>(["id"]);
	if (Array.isArray(decl.spec.unique)) {
		for (const key of decl.spec.unique)
			if (typeof key === "string") unique.add(key);
	}
	for (const [key, field] of Object.entries(fieldsOfDecl(decl) ?? {})) {
		if (flagOf(field, "unique", scope)) unique.add(key);
	}
	if (Array.isArray(decl.spec.plugins)) {
		for (const name of decl.spec.plugins) {
			const plugin = typeof name === "string" ? recordPlugin(name) : undefined;
			for (const key of plugin?.unique ?? []) unique.add(key);
		}
	}
	return unique;
}

/**
 * The entities `fields` hold, at any depth (inline fields, blueprints and
 * records that are not entities), stopping at each entity.
 */
function entitiesIn(
	fields: Readonly<Record<string, Field>>,
	scope: Scope,
): Set<string> {
	const found = new Set<string>();
	const seen = new Set<string>();
	const walk = (list: Readonly<Record<string, Field>>): void => {
		const named = (type: string): void => {
			const decl = /^[A-Z]/.test(type) ? scope.decls.get(type) : undefined;
			if (!decl) return;
			if (decl.kind === "entity") found.add(decl.name);
			else if (
				(decl.kind === "blueprint" || decl.kind === "record") &&
				!seen.has(decl.name)
			) {
				seen.add(decl.name);
				walk(fieldsOfDecl(decl) ?? {});
			}
		};
		for (const field of Object.values(list)) {
			if (field.kind === "inline") walk(field.fields);
			else if (field.kind === "type") named(field.type);
			else if (field.kind === "variant") {
				for (const target of Object.values(field.variants)) {
					if ("type" in target) named(target.type);
					else walk(target.fields);
				}
			}
		}
	};
	walk(fields);
	return found;
}

function checkStringList(
	value: unknown,
	path: Path,
	issues: SpecIssue[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		issues.push(issue(path, "invalid_option", "Must be an array of strings."));
		return undefined;
	}
	return value;
}

function checkProperty(decl: Decl, scope: Scope, issues: SpecIssue[]): void {
	const path = ["properties", decl.name];
	const { spec } = decl;
	const forms = ["base", "enum", "opaque"].filter((key) => key in spec);
	if (forms.length !== 1) {
		issues.push(
			issue(
				path,
				"invalid_property",
				'A property declares exactly one of "base" (a Std or declared property), "enum" or "opaque".',
			),
		);
		return;
	}
	const allowKeys = (keys: string[]) => {
		for (const key of Object.keys(spec)) {
			if (!keys.includes(key)) {
				issues.push(
					issue(
						[...path, key],
						"unknown_key",
						`"${key}" is not valid here. Valid keys: ${keys.join(", ")}.`,
					),
				);
			}
		}
	};
	if (spec.optional !== undefined && typeof spec.optional !== "boolean") {
		issues.push(
			issue(
				[...path, "optional"],
				"invalid_property",
				'"optional" must be a boolean.',
			),
		);
	}
	if (forms[0] === "opaque") {
		allowKeys(["opaque", "ref", "import"]);
		if (spec.opaque !== true) {
			issues.push(
				issue(
					[...path, "opaque"],
					"invalid_property",
					'"opaque" must be true.',
				),
			);
		}
		if (typeof spec.import !== "string" || spec.import === "") {
			issues.push(
				issue(
					[...path, "import"],
					"invalid_property",
					'"import" must be the module the property is exported from, relative to the output directory.',
				),
			);
		}
		if (
			spec.ref !== undefined &&
			(typeof spec.ref !== "string" || !isIdentifier(spec.ref))
		) {
			issues.push(
				issue(
					[...path, "ref"],
					"invalid_property",
					'"ref" must be the name the property is exported under.',
				),
			);
		}
		return;
	}
	if (forms[0] === "enum") {
		allowKeys(["enum", "name", "default", "optional"]);
		checkEnum(spec, path, issues);
		return;
	}
	allowKeys(["base", "with", "optional"]);
	if (typeof spec.base !== "string") {
		issues.push(
			issue(
				[...path, "base"],
				"invalid_property",
				'"base" must be the name of a Std property or a declared property.',
			),
		);
		return;
	}
	const target = targetOf(spec.base, scope);
	if (
		!target ||
		(target.kind === "std" &&
			!catalog().properties.some((p) => p.name === spec.base && p.usable))
	) {
		issues.push(
			issue(
				[...path, "base"],
				"unknown_type",
				`"${spec.base}" is not a Std property or a declared property.`,
			),
		);
		return;
	}
	if (target.kind === "decl" && target.decl.kind !== "property") {
		issues.push(
			issue(
				[...path, "base"],
				"wrong_kind",
				`"${spec.base}" is a ${target.decl.kind}; a property is based on another property.`,
			),
		);
		return;
	}
	if (spec.with !== undefined) {
		if (!isObject(spec.with)) {
			issues.push(
				issue(
					[...path, "with"],
					"invalid_with",
					'"with" must be an object of options.',
				),
			);
		} else {
			checkWith(spec.with, rootOf(spec.base, scope), [...path, "with"], issues);
		}
	}
}

function checkFieldsOf(
	decl: Decl,
	collection: string,
	owner: OwnerKind,
	scope: Scope,
	issues: SpecIssue[],
): Record<string, Field> | undefined {
	const path = [collection, decl.name];
	const keys = Object.keys(decl.spec);
	const allowed =
		owner === "entity"
			? [
					"fields",
					"sensitive",
					"unique",
					"change",
					"plugins",
					"events",
					"versioned",
					"expires",
					"schemaVersion",
					"upgrade",
					"previousNames",
				]
			: owner === "record"
				? ["fields", "sensitive", "unique", "change", "plugins"]
				: ["fields"];
	for (const key of keys) {
		if (!allowed.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: ${allowed.join(", ")}.`,
				),
			);
		}
	}
	const fields = parseFields(decl.spec.fields, [...path, "fields"], issues);
	if (!fields) return undefined;
	checkKeys(
		fields,
		[...path, "fields"],
		owner,
		issues,
		owner === "entity" ? identityKeysOf(decl.spec) : undefined,
	);
	for (const [key, field] of Object.entries(fields)) {
		checkField(field, [...path, "fields", key], scope, owner, issues);
	}
	return fields;
}

function checkRecord(
	decl: Decl,
	collection: "records" | "entities",
	scope: Scope,
	issues: SpecIssue[],
): void {
	const owner = decl.kind as "record" | "entity";
	const path = [collection, decl.name];
	const fields = checkFieldsOf(decl, collection, owner, scope, issues);
	const entries = catalog();
	if (
		decl.spec.versioned !== undefined &&
		typeof decl.spec.versioned !== "boolean"
	) {
		issues.push(
			issue(
				[...path, "versioned"],
				"invalid_option",
				"Expected true or false.",
			),
		);
	}
	const identityKeys = owner === "entity" ? identityKeysOf(decl.spec) : [];
	if (owner === "entity" && decl.spec.events !== undefined) {
		checkEntityEvents(
			decl.name,
			decl.spec.events,
			[...path, "events"],
			scope,
			issues,
		);
	}

	if (owner === "entity") {
		checkEntitySchema(decl.name, decl.spec, path, issues);
	}

	if (owner === "entity" && decl.spec.expires !== undefined) {
		checkEntityExpires(
			decl.spec.expires,
			fields,
			[...path, "expires"],
			scope,
			issues,
		);
	}

	const plugins = checkStringList(
		decl.spec.plugins,
		[...path, "plugins"],
		issues,
	);
	const pluginKeys = new Set<string>();
	const taken = new Set<string>([
		...Object.keys(fields ?? {}),
		...identityKeys,
	]);
	const seenPlugins = new Set<string>();
	for (const [index, name] of (plugins ?? []).entries()) {
		const plugin = recordPlugin(name);
		const here = [...path, "plugins", index];
		if (!plugin) {
			issues.push(
				issue(
					here,
					"unknown_plugin",
					`"${name}" is not a Std record plugin. Available: ${entries.recordPlugins.map((p) => p.name).join(", ")}.`,
				),
			);
			continue;
		}
		if (seenPlugins.has(name)) {
			issues.push(
				issue(here, "duplicate_plugin", `"${name}" is listed twice.`),
			);
			continue;
		}
		seenPlugins.add(name);
		for (const key of plugin.keys) {
			if (taken.has(key)) {
				issues.push(
					issue(
						here,
						"plugin_conflict",
						`The plugin "${name}" adds the key "${key}", which ${Object.hasOwn(fields ?? {}, key) ? "the fields already declare" : "is already taken (by an identity key or another plugin)"}.`,
					),
				);
			}
			taken.add(key);
			pluginKeys.add(key);
		}
	}

	const known = new Set<string>([...Object.keys(fields ?? {}), ...pluginKeys]);
	const identity = new Set<string>(identityKeys);
	for (const option of ["unique", "sensitive", "change"] as const) {
		const keys = checkStringList(decl.spec[option], [...path, option], issues);
		for (const [index, key] of (keys ?? []).entries()) {
			const here = [...path, option, index];
			if (option === "change" && owner === "entity" && identity.has(key)) {
				issues.push(
					issue(
						here,
						"change_identity",
						`"${key}" is part of the identity of an entity and cannot be changed (no change.${key}).`,
					),
				);
			} else if (
				!known.has(key) &&
				!(owner === "entity" && option !== "change" && identity.has(key))
			) {
				issues.push(
					issue(
						here,
						"unknown_field",
						`"${key}" in ${option} is not a field of "${decl.name}"${pluginKeys.size ? " or of its plugins" : ""}. Fields: ${[...known].join(", ") || "(none)"}.`,
					),
				);
			}
		}
	}
}

/**
 * The `indexes` of a repository: `{ name: { where: [keys], orderBy?: key } }`
 * over the keys of `entity` (when it is known), none of them sensitive, with
 * a scalar `orderBy`, and no two the same.
 */
function checkIndexes(
	indexes: unknown,
	path: Path,
	entity: Decl | undefined,
	scope: Scope,
	issues: SpecIssue[],
): void {
	if (indexes === undefined) return;
	if (!isObject(indexes)) {
		issues.push(
			issue(
				path,
				"invalid_index",
				"Expected an object of indexes by name: { name: { where: [keys], orderBy?: key } }.",
			),
		);
		return;
	}
	const keys = entity ? new Set(keysOf(entity)) : undefined;
	const fields = entity ? (fieldsOfDecl(entity) ?? {}) : {};
	const sensitive = new Set<string>(
		entity && Array.isArray(entity.spec.sensitive)
			? entity.spec.sensitive.filter(
					(key): key is string => typeof key === "string",
				)
			: [],
	);
	for (const [key, field] of Object.entries(fields)) {
		if (flagOf(field, "sensitive", scope)) sensitive.add(key);
	}
	const seen = new Map<string, string>();
	for (const [name, index] of Object.entries(indexes)) {
		const here = [...path, name];
		if (!isIdentifier(name)) {
			issues.push(
				issue(here, "invalid_index", `"${name}" must be an identifier.`),
			);
			continue;
		}
		if (
			!isObject(index) ||
			Object.keys(index).some((key) => key !== "where" && key !== "orderBy") ||
			!Array.isArray(index.where) ||
			index.where.length === 0 ||
			index.where.some((key) => typeof key !== "string") ||
			(index.orderBy !== undefined && typeof index.orderBy !== "string")
		) {
			issues.push(
				issue(
					here,
					"invalid_index",
					'Expected { "where": [keys], "orderBy"?: key }, with at least one key.',
				),
			);
			continue;
		}
		const where = index.where as string[];
		const orderBy = index.orderBy as string | undefined;
		let valid = true;
		const named: [Path, string][] = [
			...where.map((key, at): [Path, string] => [[...here, "where", at], key]),
			...(orderBy === undefined
				? []
				: [[[...here, "orderBy"], orderBy] as [Path, string]]),
		];
		for (const [at, key] of named) {
			if (keys && !keys.has(key)) {
				issues.push(
					issue(
						at,
						"unknown_index_key",
						`"${key}" is not a key of "${entity?.name}". Keys: ${[...keys].join(", ")}.`,
					),
				);
				valid = false;
			} else if (sensitive.has(key)) {
				issues.push(
					issue(
						at,
						"invalid_index",
						`"${key}" is sensitive and cannot be indexed.`,
					),
				);
				valid = false;
			}
		}
		if (new Set(where).size !== where.length) {
			issues.push(
				issue(
					[...here, "where"],
					"invalid_index",
					"A key is listed twice in where.",
				),
			);
			valid = false;
		}
		const ordered = orderBy === undefined ? undefined : fields[orderBy];
		if (ordered && !isScalarField(ordered, scope)) {
			issues.push(
				issue(
					[...here, "orderBy"],
					"invalid_index",
					`"${orderBy}" is not scalar; an index orders by a scalar key.`,
				),
			);
			valid = false;
		}
		if (!valid) continue;
		const signature = JSON.stringify([[...where].sort(), orderBy ?? null]);
		const other = seen.get(signature);
		if (other !== undefined) {
			issues.push(
				issue(
					here,
					"invalid_index",
					`"${name}" is the same index as "${other}".`,
				),
			);
			continue;
		}
		seen.set(signature, name);
	}
}

/** Whether `field` holds one scalar: not a list, an inline object, a variant, or a blueprint, record or entity. */
function isScalarField(field: Field, scope: Scope): boolean {
	if (field.list || field.kind === "inline" || field.kind === "variant")
		return false;
	if (field.kind !== "type" || !/^[A-Z]/.test(field.type)) return true;
	const decl = scope.decls.get(field.type);
	return (
		decl === undefined ||
		(decl.kind !== "blueprint" &&
			decl.kind !== "record" &&
			decl.kind !== "entity")
	);
}

function checkRepository(
	decl: Decl,
	scope: Scope,
	providers: readonly ProviderCatalogEntry[],
	issues: SpecIssue[],
): void {
	const path = ["repositories", decl.name];
	const { spec } = decl;
	for (const key of Object.keys(spec)) {
		if (
			![
				"entity",
				"actions",
				"provider",
				"deletion",
				"relations",
				"environments",
				"indexes",
				"scans",
			].includes(key)
		) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: entity, actions, provider, deletion, relations, environments, indexes, scans.`,
				),
			);
		}
	}
	if (spec.provider !== undefined) {
		checkProvider(
			spec.provider,
			[...path, "provider"],
			providers,
			issues,
			usableProviderKeys(scope),
		);
	}
	if (
		spec.deletion !== undefined &&
		spec.deletion !== "hard" &&
		spec.deletion !== "soft"
	) {
		issues.push(
			issue(
				[...path, "deletion"],
				"invalid_deletion",
				'Expected "hard" or "soft".',
			),
		);
	}
	if (
		spec.scans !== undefined &&
		spec.scans !== "allow" &&
		spec.scans !== "warn" &&
		spec.scans !== "reject"
	) {
		issues.push(
			issue(
				[...path, "scans"],
				"invalid_option",
				'Expected "allow", "warn" or "reject".',
			),
		);
	}
	const target =
		typeof spec.entity === "string" ? scope.decls.get(spec.entity) : undefined;
	checkIndexes(
		spec.indexes,
		[...path, "indexes"],
		target?.kind === "entity" ? target : undefined,
		scope,
		issues,
	);
	if (target?.kind !== "entity") {
		issues.push(
			issue(
				[...path, "entity"],
				"unknown_entity",
				target
					? `"${spec.entity}" is a ${target.kind}; a repository is of an entity.`
					: `"entity" must name a declared entity${typeof spec.entity === "string" ? ` ("${spec.entity}" is not)` : ""}.`,
			),
		);
	}
	const actions = checkStringList(spec.actions, [...path, "actions"], issues);
	if (spec.actions === undefined) {
		issues.push(
			issue(
				[...path, "actions"],
				"invalid_option",
				'"actions" is required: the repository only gets the methods listed.',
			),
		);
	}
	if (target?.kind === "entity" && actions) {
		const keys = keysOf(target);
		const unique = uniqueKeysOf(target, scope);
		const byAction = new Map(
			keys.map((key) => [key.charAt(0).toUpperCase() + key.slice(1), key]),
		);
		const seen = new Set<string>();
		for (const [index, action] of actions.entries()) {
			const here = [...path, "actions", index];
			if (seen.has(action)) {
				issues.push(
					issue(here, "duplicate_action", `"${action}" is listed twice.`),
				);
				continue;
			}
			seen.add(action);
			if (action === "restore" && spec.deletion !== "soft") {
				issues.push(
					issue(
						here,
						"restore_needs_soft",
						'"restore" needs "deletion": "soft" on the repository.',
					),
				);
				continue;
			}
			if (
				[
					"create",
					"update",
					"delete",
					"restore",
					"count",
					"findMany",
					"exists",
					"findPage",
					"findCursor",
					"explain",
					"forEachPage",
				].includes(action)
			)
				continue;
			if (action === "increment") {
				if (numericChangeKeysOf(target, scope).length === 0) {
					issues.push(
						issue(
							here,
							"increment_needs_number",
							`"increment" needs a number key in the change list of ${target.name}.`,
						),
					);
				}
				continue;
			}
			const match = /^(findBy|findManyBy)(.+)$/.exec(action);
			if (!match) {
				issues.push(
					issue(
						here,
						"unknown_action",
						`"${action}" is not an action. Use create, update, delete, restore, increment, count, findMany, exists, findPage, findCursor, explain, forEachPage, findBy<Key> or findManyBy<Key>.`,
					),
				);
				continue;
			}
			const key = byAction.get(match[2] as string);
			if (key === undefined) {
				issues.push(
					issue(
						here,
						"action_unknown_key",
						`"${action}" names "${match[2]}", which is not a key of "${target.name}". Keys: ${keys.join(", ")}.`,
					),
				);
			} else if (match[1] === "findBy" && !unique.has(key)) {
				issues.push(
					issue(
						here,
						"action_not_unique",
						`"${action}" requires "${key}" to be a unique key of ${target.name}; use "findManyBy${match[2]}" or add "${key}" to the entity's unique.`,
					),
				);
			} else if (match[1] === "findManyBy" && unique.has(key)) {
				issues.push(
					issue(
						here,
						"action_unique",
						`"findManyBy${match[2]}" is not available for the unique key "${key}"; use "findBy${match[2]}".`,
					),
				);
			}
		}
	}

	const relations =
		checkStringList(spec.relations, [...path, "relations"], issues) ?? [];
	const covered = new Map<string, string>();
	let relationsOk = true;
	for (const [index, name] of relations.entries()) {
		const here = [...path, "relations", index];
		const other = scope.decls.get(name);
		if (other?.kind !== "repository") {
			issues.push(
				issue(
					here,
					"unknown_relation",
					`"${name}" is not a declared repository.`,
				),
			);
			relationsOk = false;
			continue;
		}
		const entity =
			typeof other.spec.entity === "string" ? other.spec.entity : "";
		if (covered.has(entity)) {
			issues.push(
				issue(
					here,
					"invalid_relations",
					`"${name}" and "${covered.get(entity)}" are both repositories of "${entity}"; list one per entity.`,
				),
			);
			relationsOk = false;
			continue;
		}
		covered.set(entity, name);
	}
	if (target?.kind === "entity" && relationsOk) {
		const needed = entitiesIn(fieldsOfDecl(target) ?? {}, scope);
		for (const entity of [...needed].sort()) {
			if (!covered.has(entity)) {
				issues.push(
					issue(
						[...path, "relations"],
						"missing_relation",
						`"${target.name}" holds the entity "${entity}" (directly or deeper); list the repository of "${entity}" in relations.`,
					),
				);
			}
		}
		for (const [entity, name] of covered) {
			if (!needed.has(entity)) {
				issues.push(
					issue(
						[...path, "relations"],
						"extra_relation",
						`"${name}" is a repository of "${entity}", which "${target.name}" does not hold; remove it from relations.`,
					),
				);
			}
		}
	}

	checkEnvironmentNames(
		spec.environments,
		[...path, "environments"],
		scope,
		issues,
	);
}

/** Everything that makes `input` an invalid `afora.json`, never throwing. */
export function validateSpec(
	input: unknown,
	extended: Readonly<Record<string, ResolvedSpec>> = {},
	options: CodegenOptions = {},
): SpecIssue[] {
	const issues: SpecIssue[] = [];
	if (!isObject(input)) {
		return [issue([], "invalid_spec", "The spec must be a JSON object.")];
	}
	try {
		check(
			input,
			extended,
			options.providers ?? [],
			options.stages ?? [],
			options.policies ?? [],
			issues,
		);
	} catch (error) {
		issues.push(
			issue(
				[],
				"internal_error",
				`The validator failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}
	return issues;
}

function check(
	input: Record<string, unknown>,
	extended: Readonly<Record<string, ResolvedSpec>>,
	providers: readonly ProviderCatalogEntry[],
	stages: readonly StageCatalogEntry[],
	policies: readonly EventPolicyCatalogEntry[],
	issues: SpecIssue[],
): void {
	checkCatalog(providers, issues);
	checkStageCatalog(stages, issues);
	checkPolicyCatalog(policies, issues);
	const stageMap = stageEntries(stages);
	const policyMap = policyEntries(policies);
	checkPublishers(input.publishers, issues);
	checkProviders(input.providers, providers, issues);
	if (input.log !== undefined) checkLog(input.log, ["log"], issues);
	if (input.trace !== undefined) checkTrace(input.trace, ["trace"], issues);
	for (const key of Object.keys(input)) {
		if (!TOP_LEVEL_KEYS.includes(key)) {
			issues.push(
				issue(
					[key],
					"unknown_key",
					`"${key}" is not a valid key. Valid keys: ${TOP_LEVEL_KEYS.join(", ")}.`,
				),
			);
		}
	}
	if (input.version !== 1) {
		issues.push(
			issue(["version"], "unsupported_version", '"version" must be 1.'),
		);
	}
	if (
		input.name !== undefined &&
		(typeof input.name !== "string" || input.name === "")
	) {
		issues.push(
			issue(["name"], "invalid_name", '"name" must be a non-empty string.'),
		);
	}
	if (input.extends !== undefined) {
		if (
			!Array.isArray(input.extends) ||
			!input.extends.every((ref) => typeof ref === "string" && ref !== "")
		) {
			issues.push(
				issue(
					["extends"],
					"invalid_extends",
					'"extends" must be an array of references: relative paths to another afora.json, or package names.',
				),
			);
		} else if (new Set(input.extends).size !== input.extends.length) {
			issues.push(
				issue(
					["extends"],
					"invalid_extends",
					'"extends" lists a reference twice.',
				),
			);
		}
	}
	if (input.output !== undefined) {
		const { output } = input;
		const dir = isObject(output) ? output.dir : undefined;
		if (
			typeof dir !== "string" ||
			dir === "" ||
			dir.startsWith("/") ||
			/(^|[\\/])\.\.([\\/]|$)/.test(dir)
		) {
			issues.push(
				issue(
					["output", "dir"],
					"invalid_output",
					'"output.dir" must be a relative directory inside the project (no "..").',
				),
			);
		}
	}

	const scope = scopeOf(input, extended, issues);
	if (input.provider !== undefined) {
		checkProvider(
			input.provider,
			["provider"],
			providers,
			issues,
			usableProviderKeys(scope),
		);
	}
	const own = [...scope.decls.values()].filter(
		(decl) => decl.via === undefined,
	);
	const checkInline = (value: unknown, path: readonly (string | number)[]) => {
		const fields = parseFields(value, path, issues);
		if (!fields) return undefined;
		checkKeys(fields, path, "inline", issues);
		for (const [key, field] of Object.entries(fields)) {
			checkField(field, [...path, key], scope, "inline", issues);
		}
		return fields;
	};
	for (const decl of own) {
		switch (decl.kind) {
			case "property":
				checkProperty(decl, scope, issues);
				break;
			case "blueprint":
				checkFieldsOf(decl, "blueprints", "blueprint", scope, issues);
				break;
			case "record":
				checkRecord(decl, "records", scope, issues);
				break;
			case "entity":
				checkRecord(decl, "entities", scope, issues);
				break;
			case "environment":
				checkFieldsOf(decl, "environments", "environment", scope, issues);
				break;
			case "repository":
				checkRepository(decl, scope, providers, issues);
				break;
			case "exception":
				checkException(decl, issues);
				break;
			case "useCase":
				checkUseCase(decl, scope, checkInline, issues);
				break;
			case "command":
				checkCommand(decl, scope, checkInline, issues, policyMap);
				break;
			case "output":
				checkOutput(decl, scope, stageMap, issues);
				break;
		}
	}
	for (const cycle of orderOf(own, scope).cycles) {
		const first = scope.decls.get(cycle[0] as string);
		const collection = COLLECTIONS.find(
			(key) => first && KIND_OF[key] === first.kind,
		);
		issues.push(
			issue(
				collection ? [collection, cycle[0] as string] : [],
				"cycle",
				`Circular reference ${cycle.join(" -> ")}. v1 does not support cycles between declarations (the class types would be circular); break the loop, e.g. store an id instead of the entity.`,
			),
		);
	}
	// Stable output: by path, then code.
	issues.sort(
		(a, b) =>
			a.path.join("/").localeCompare(b.path.join("/")) ||
			a.code.localeCompare(b.code),
	);
}
