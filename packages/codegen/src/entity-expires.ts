import { Std } from "@afora/core";
import { rootOf } from "./graph";
import type { Field } from "./model";
import { issue, type Scope } from "./scope";
import { isObject } from "./spec/field";
import type { EntityExpiresSpec, SpecIssue } from "./spec/types";

/** The units of a duration, in their canonical order. */
const DURATION_UNITS = ["days", "hours", "minutes", "seconds"] as const;

/** The identity key an entity expiring `after` a duration keeps its expiry in. */
const EXPIRES_AT = "expiresAt";

interface RuntimeProperty {
	readonly type: { readonly schema: { readonly type: { Type(): unknown } } };
}

/** Whether the std property `name` holds a date, or a date and time. */
function isStdDate(name: string): boolean {
	const Property = (
		Std.properties as Readonly<Record<string, RuntimeProperty | undefined>>
	)[name];
	if (!Property) return false;
	const { format } = Property.type.schema.type.Type() as { format?: unknown };
	return format === "date-time" || format === "date";
}

/** Whether `field` holds one date: a std date property, or one derived from it. */
function isDateField(field: Field | undefined, scope: Scope): boolean {
	if (field?.kind !== "type" || field.list !== undefined) return false;
	const root = rootOf(field.type, scope);
	return root?.kind === "std" && isStdDate(root.info.name);
}

/**
 * Checks the `expires` of an entity: `{ "after": { "days": 400 } }`, a
 * non-empty duration of positive numbers, or `{ "at": "<key>" }`, a date field
 * of the entity; with `after`, no field may be named `expiresAt`.
 */
export function checkEntityExpires(
	value: unknown,
	fields: Readonly<Record<string, Field>> | undefined,
	path: readonly (string | number)[],
	scope: Scope,
	issues: SpecIssue[],
): void {
	const invalid = (message: string, at = path) =>
		issues.push(issue(at, "invalid_expires", message));
	if (!isObject(value) || Object.keys(value).length !== 1) {
		invalid(
			'Expected { "after": { "days": 400 } } or { "at": "<a date field>" }.',
		);
		return;
	}
	if ("at" in value) {
		const { at } = value;
		if (typeof at !== "string" || fields === undefined) {
			if (typeof at !== "string") invalid("at must name a date field.");
			return;
		}
		if (!Object.hasOwn(fields, at)) {
			invalid(`"${at}" is not a field of the entity.`, [...path, "at"]);
		} else if (!isDateField(fields[at], scope)) {
			invalid(
				`"${at}" does not hold a date: use a dateTime or date field (optional or not).`,
				[...path, "at"],
			);
		}
		return;
	}
	if (!("after" in value)) {
		invalid(
			'Expected { "after": { "days": 400 } } or { "at": "<a date field>" }.',
		);
		return;
	}
	const { after } = value;
	if (!isObject(after) || Object.keys(after).length === 0) {
		invalid('after must be a non-empty duration, e.g. { "days": 400 }.', [
			...path,
			"after",
		]);
		return;
	}
	for (const [unit, amount] of Object.entries(after)) {
		const here = [...path, "after", unit];
		if (!(DURATION_UNITS as readonly string[]).includes(unit)) {
			invalid(
				`"${unit}" is not a unit of a duration (${DURATION_UNITS.join(", ")}).`,
				here,
			);
		} else if (
			typeof amount !== "number" ||
			!Number.isFinite(amount) ||
			amount <= 0
		) {
			invalid(`${unit} must be a positive number.`, here);
		}
	}
	if (fields !== undefined && Object.hasOwn(fields, EXPIRES_AT)) {
		issues.push(
			issue(
				[...path.slice(0, -1), "fields", EXPIRES_AT],
				"identity_key",
				`"${EXPIRES_AT}" is the identity key that expires: { after } adds; remove it from the fields, or use { "at": "${EXPIRES_AT}" }.`,
			),
		);
	}
}

/** `expires` in its canonical form: the units of `after` in order. */
export function canonicalExpires(
	value: unknown,
): EntityExpiresSpec | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.at === "string") return { at: value.at };
	if (!isObject(value.after)) return undefined;
	const after = value.after;
	return {
		after: Object.fromEntries(
			DURATION_UNITS.filter((unit) => after[unit] !== undefined).map((unit) => [
				unit,
				after[unit] as number,
			]),
		),
	};
}
