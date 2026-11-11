import { type Decl, issue, type Scope } from "./scope";
import {
	boundsOf,
	isDeclarationName,
	isObject,
	parseShorthand,
} from "./spec/field";
import type {
	EnumValue,
	ListBounds,
	SpecIssue,
	WithOptions,
} from "./spec/types";

/** A field, parsed: shorthand and object forms alike. */
export type Field = {
	readonly optional: boolean;
	/** Present when the field is a list. */
	readonly list?: ListBounds;
} & (
	| ({
			readonly kind: "type";
			readonly type: string;
			readonly with?: WithOptions;
	  } & FieldEvolution)
	| ({
			readonly kind: "enum";
			readonly values: readonly EnumValue[];
			readonly name?: string;
			readonly default?: EnumValue;
	  } & FieldEvolution)
	| {
			readonly kind: "inline";
			readonly fields: Readonly<Record<string, Field>>;
	  }
	| {
			readonly kind: "variant";
			readonly key: string;
			readonly variants: Readonly<Record<string, VariantTarget>>;
	  }
);

/** A variant of a variant field: a declaration by name, or a blueprint declared in place. */
export type VariantTarget =
	| { readonly type: string }
	| { readonly fields: Readonly<Record<string, Field>> };

/** What a stored row lacking the key gets, and the key that held it before. */
interface FieldEvolution {
	readonly fill?: unknown;
	readonly renamedFrom?: string;
}

const MODIFIERS = ["optional", "list"];
const EVOLUTION = ["fill", "renamedFrom"];

/** `fill` and `renamedFrom` of a field object, checked; `undefined` when invalid. */
function evolutionOf(
	value: Record<string, unknown>,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): FieldEvolution | undefined {
	const { fill, renamedFrom } = value;
	if (fill === undefined && renamedFrom === undefined) return {};
	let ok = true;
	if (value.list !== undefined && value.list !== false) {
		issues.push(
			issue(
				path,
				"invalid_field",
				'"fill" and "renamedFrom" do not apply to a list field.',
			),
		);
		ok = false;
	}
	if (fill === null) {
		issues.push(
			issue([...path, "fill"], "invalid_field", '"fill" cannot be null.'),
		);
		ok = false;
	}
	if (
		renamedFrom !== undefined &&
		(typeof renamedFrom !== "string" ||
			!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(renamedFrom))
	) {
		issues.push(
			issue(
				[...path, "renamedFrom"],
				"invalid_field",
				'"renamedFrom" must be the key the value had before, an identifier.',
			),
		);
		ok = false;
	}
	if (!ok) return undefined;
	return {
		...(fill === undefined ? {} : { fill }),
		...(renamedFrom === undefined
			? {}
			: { renamedFrom: renamedFrom as string }),
	};
}

function checkKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: readonly (string | number)[],
	issues: SpecIssue[],
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not a valid key here. Valid keys: ${allowed.join(", ")}.`,
				),
			);
		}
	}
}

/** Checks the bounds of a list modifier; `undefined` for no list or an invalid one. */
function listOf(
	value: unknown,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): ListBounds | undefined {
	if (value === undefined || value === false) return undefined;
	const bounds = boundsOf(value);
	if (!bounds) {
		issues.push(
			issue(
				path,
				"invalid_list",
				'"list" must be true or an object { minItems?, maxItems? }.',
			),
		);
		return undefined;
	}
	const { minItems, maxItems } = bounds as Record<string, unknown>;
	for (const [key, bound] of [
		["minItems", minItems],
		["maxItems", maxItems],
	] as const) {
		if (
			bound !== undefined &&
			(typeof bound !== "number" || !Number.isInteger(bound) || bound < 0)
		) {
			issues.push(
				issue(
					[...path, key],
					"invalid_list",
					`"${key}" must be a non-negative integer.`,
				),
			);
		}
	}
	for (const key of Object.keys(bounds)) {
		if (key !== "minItems" && key !== "maxItems") {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not a list option. Valid: minItems, maxItems.`,
				),
			);
		}
	}
	if (
		typeof minItems === "number" &&
		typeof maxItems === "number" &&
		minItems > maxItems
	) {
		issues.push(
			issue(
				path,
				"invalid_list",
				'"minItems" cannot be greater than "maxItems".',
			),
		);
	}
	return {
		...(typeof minItems === "number" ? { minItems } : {}),
		...(typeof maxItems === "number" ? { maxItems } : {}),
	};
}

/** Checks the values of an enum. */
export function checkEnum(
	value: Record<string, unknown>,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): boolean {
	const { enum: values, name } = value;
	let ok = true;
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		!values.every(
			(item) => typeof item === "string" || typeof item === "number",
		)
	) {
		issues.push(
			issue(
				[...path, "enum"],
				"invalid_enum",
				'"enum" must be a non-empty array of strings or numbers.',
			),
		);
		return false;
	}
	if (new Set(values).size !== values.length) {
		issues.push(
			issue([...path, "enum"], "invalid_enum", "Enum values must be unique."),
		);
		ok = false;
	}
	if (name !== undefined && (typeof name !== "string" || name === "")) {
		issues.push(
			issue(
				[...path, "name"],
				"invalid_enum",
				'"name" must be a non-empty string.',
			),
		);
		ok = false;
	}
	if (
		value.default !== undefined &&
		!(values as unknown[]).includes(value.default)
	) {
		issues.push(
			issue(
				[...path, "default"],
				"invalid_enum",
				'"default" must be one of the enum values.',
			),
		);
		ok = false;
	}
	return ok;
}

/**
 * A field of a spec, parsed. Reports to `issues` what is malformed and gives
 * `undefined` when it cannot be used.
 */
export function parseField(
	value: unknown,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): Field | undefined {
	if (typeof value === "string") {
		const parsed = parseShorthand(value);
		if (!parsed) {
			issues.push(
				issue(
					path,
					"invalid_field",
					`"${value}" is not a field. Use a type name with optional "[]" and "?", e.g. "email", "Age?", "string[]", "User[]?".`,
				),
			);
			return undefined;
		}
		return {
			kind: "type",
			type: parsed.type,
			optional: parsed.optional,
			...(parsed.list ? { list: {} } : {}),
		};
	}
	if (!isObject(value)) {
		issues.push(
			issue(
				path,
				"invalid_field",
				'A field is a string ("email", "Age?", "User[]") or an object ({ "type": ... }, { "enum": [...] }, { "fields": {...} } or { "variant": {...} }).',
			),
		);
		return undefined;
	}
	if ("opaque" in value || "ref" in value || "import" in value) {
		issues.push(
			issue(
				path,
				"invalid_field",
				'An opaque property is declared under "properties" ({ "opaque": true, "import": "..." }) and used by name.',
			),
		);
		return undefined;
	}
	const forms = ["type", "enum", "fields", "variant"].filter(
		(key) => key in value,
	);
	if (forms.length !== 1) {
		issues.push(
			issue(
				path,
				"invalid_field",
				'A field object has exactly one of "type", "enum", "fields" or "variant".',
			),
		);
		return undefined;
	}
	const modifiers = (): Pick<Field, "optional" | "list"> | undefined => {
		if (value.optional !== undefined && typeof value.optional !== "boolean") {
			issues.push(
				issue(
					[...path, "optional"],
					"invalid_field",
					'"optional" must be a boolean.',
				),
			);
			return undefined;
		}
		const before = issues.length;
		const list = listOf(value.list, [...path, "list"], issues);
		if (issues.length > before) return undefined;
		return { optional: value.optional === true, ...(list ? { list } : {}) };
	};
	if (forms[0] === "type") {
		checkKeys(
			value,
			["type", "with", ...MODIFIERS, ...EVOLUTION],
			path,
			issues,
		);
		if (
			typeof value.type !== "string" ||
			!parseShorthand(value.type) ||
			parseShorthand(value.type)?.list ||
			parseShorthand(value.type)?.optional
		) {
			issues.push(
				issue(
					[...path, "type"],
					"invalid_field",
					'"type" must be the name of a Std property or a declaration (use "optional" and "list" instead of "?" and "[]").',
				),
			);
			return undefined;
		}
		if (value.with !== undefined && !isObject(value.with)) {
			issues.push(
				issue(
					[...path, "with"],
					"invalid_with",
					'"with" must be an object of options.',
				),
			);
			return undefined;
		}
		const mods = modifiers();
		const evolution = evolutionOf(value, path, issues);
		if (!mods || !evolution) return undefined;
		return {
			kind: "type",
			type: value.type,
			...(value.with ? { with: value.with as WithOptions } : {}),
			...evolution,
			...mods,
		};
	}
	if (forms[0] === "enum") {
		checkKeys(
			value,
			["enum", "name", "default", ...MODIFIERS, ...EVOLUTION],
			path,
			issues,
		);
		const before = issues.length;
		if (!checkEnum(value, path, issues) || issues.length > before)
			return undefined;
		const mods = modifiers();
		const evolution = evolutionOf(value, path, issues);
		if (!mods || !evolution) return undefined;
		if (
			evolution.fill !== undefined &&
			!(value.enum as unknown[]).includes(evolution.fill)
		) {
			issues.push(
				issue(
					[...path, "fill"],
					"invalid_enum",
					'"fill" must be one of the enum values.',
				),
			);
			return undefined;
		}
		return {
			kind: "enum",
			values: value.enum as EnumValue[],
			...(value.name === undefined ? {} : { name: value.name as string }),
			...(value.default === undefined
				? {}
				: { default: value.default as EnumValue }),
			...evolution,
			...mods,
		};
	}
	if (forms[0] === "variant") {
		checkKeys(value, ["variant", ...MODIFIERS], path, issues);
		const variant = parseVariant(value.variant, [...path, "variant"], issues);
		const mods = modifiers();
		if (!variant || !mods) return undefined;
		return { kind: "variant", ...variant, ...mods };
	}
	checkKeys(value, ["fields", ...MODIFIERS], path, issues);
	const fields = parseFields(value.fields, [...path, "fields"], issues);
	const mods = modifiers();
	if (!fields || !mods) return undefined;
	return { kind: "inline", fields, ...mods };
}

/** The `variant` of a variant field, parsed: its key and its variants. */
function parseVariant(
	value: unknown,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): { key: string; variants: Record<string, VariantTarget> } | undefined {
	if (!isObject(value)) {
		issues.push(
			issue(
				path,
				"invalid_variant",
				'"variant" must be an object { "key": "type", "of": { "click": "Click" } }.',
			),
		);
		return undefined;
	}
	checkKeys(value, ["key", "of"], path, issues);
	let ok = true;
	if (typeof value.key !== "string" || value.key === "") {
		issues.push(
			issue(
				[...path, "key"],
				"invalid_variant",
				'"key" must be a string that is not empty: the key whose value names the variant.',
			),
		);
		ok = false;
	}
	if (!isObject(value.of) || Object.keys(value.of).length === 0) {
		issues.push(
			issue(
				[...path, "of"],
				"invalid_variant",
				'"of" must be an object with at least one variant, by the value the key has for it: { "click": "Click" }.',
			),
		);
		return undefined;
	}
	const variants: Record<string, VariantTarget> = {};
	for (const [tag, target] of Object.entries(value.of)) {
		const here = [...path, "of", tag];
		if (typeof target === "string") {
			if (isDeclarationName(target)) variants[tag] = { type: target };
			else {
				issues.push(
					issue(
						here,
						"invalid_variant",
						`"${target}" is not the name of a declaration. A variant is a declared blueprint, record or entity (PascalCase), or a blueprint declared in place ({ "fields": {...} }).`,
					),
				);
				ok = false;
			}
			continue;
		}
		if (isObject(target) && "fields" in target) {
			checkKeys(target, ["fields"], here, issues);
			const fields = parseFields(target.fields, [...here, "fields"], issues);
			if (fields) variants[tag] = { fields };
			else ok = false;
			continue;
		}
		issues.push(
			issue(
				here,
				"invalid_variant",
				'A variant is the name of a declared blueprint, record or entity, or a blueprint declared in place ({ "fields": {...} }).',
			),
		);
		ok = false;
	}
	return ok ? { key: value.key as string, variants } : undefined;
}

/** The fields of a blueprint, record, entity or environment, parsed. */
export function parseFields(
	value: unknown,
	path: readonly (string | number)[],
	issues: SpecIssue[],
): Record<string, Field> | undefined {
	if (!isObject(value)) {
		issues.push(
			issue(
				path,
				"invalid_fields",
				'"fields" must be an object of fields by key.',
			),
		);
		return undefined;
	}
	const fields: Record<string, Field> = {};
	let ok = true;
	for (const [key, field] of Object.entries(value)) {
		const parsed = parseField(field, [...path, key], issues);
		if (parsed) fields[key] = parsed;
		else ok = false;
	}
	return ok ? fields : undefined;
}

/** What a type name stands for. */
export type Target =
	| { readonly kind: "std"; readonly name: string }
	| { readonly kind: "decl"; readonly decl: Decl };

export function targetOf(type: string, scope: Scope): Target | undefined {
	if (/^[a-z]/.test(type)) return { kind: "std", name: type };
	const decl = scope.decls.get(type);
	return decl ? { kind: "decl", decl } : undefined;
}
