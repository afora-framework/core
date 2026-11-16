import type { TSchema } from "typebox";
import { Format } from "typebox/format";

/**
 * Fast checks for the string formats whose TypeBox check is slow (`date-time`
 * takes about 250 ns: it splits the string with a regular expression and runs
 * two more), for the form they almost always come in. A fast check never
 * rejects: it answers `true` for a value TypeBox accepts, or `false` for "ask
 * TypeBox", so what is accepted is exactly what TypeBox accepts.
 */

const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The number written by the two digits at `at`, or -1. */
function twoDigits(value: string, at: number): number {
	const tens = value.charCodeAt(at) - 48;
	const units = value.charCodeAt(at + 1) - 48;
	if (tens < 0 || tens > 9 || units < 0 || units > 9) return -1;
	return tens * 10 + units;
}

/** Whether `value` starts with a valid `YYYY-MM-DD`. */
function startsWithDate(value: string): boolean {
	const century = twoDigits(value, 0);
	const rest = twoDigits(value, 2);
	if (century < 0 || rest < 0) return false;
	if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return false;
	const month = twoDigits(value, 5);
	const day = twoDigits(value, 8);
	if (month < 1 || month > 12 || day < 1) return false;
	const year = century * 100 + rest;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	return day <= (month === 2 && leap ? 29 : (DAYS[month] as number));
}

/**
 * Whether `value` is a calendar date `YYYY-MM-DD`, as RFC 3339 writes it;
 * `false` means "ask TypeBox".
 * @internal
 */
export function isPlainDate(value: string): boolean {
	return value.length === 10 && startsWithDate(value);
}

/**
 * Whether `value` is a date and time in UTC as `toISOString` writes it,
 * `YYYY-MM-DDTHH:MM:SS` with an optional fraction and `Z`; `false` means "ask
 * TypeBox", which also takes offsets, a lower case `t` or `z`, a leap second
 * and RFC 9557 suffixes.
 * @internal
 */
export function isUtcDateTime(value: string): boolean {
	const length = value.length;
	if (length < 20 || value.charCodeAt(length - 1) !== 90) return false;
	if (!startsWithDate(value)) return false;
	if (
		value.charCodeAt(10) !== 84 ||
		value.charCodeAt(13) !== 58 ||
		value.charCodeAt(16) !== 58
	) {
		return false;
	}
	const hour = twoDigits(value, 11);
	const minute = twoDigits(value, 14);
	const second = twoDigits(value, 17);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
	if (second < 0 || second > 59) return false;
	if (length === 20) return true;
	// A fraction: a dot and at least one digit, up to the `Z`.
	if (value.charCodeAt(19) !== 46 || length === 21) return false;
	for (let at = 20; at < length - 1; at++) {
		const digit = value.charCodeAt(at) - 48;
		if (digit < 0 || digit > 9) return false;
	}
	return true;
}

/** The fast check of each format, with the TypeBox check it stands in for. */
const FAST_FORMATS: ReadonlyMap<
	string,
	{ readonly fast: (value: string) => boolean; readonly typebox: unknown }
> = new Map([
	["date-time", { fast: isUtcDateTime, typebox: Format.IsDateTime }],
	["date", { fast: isPlainDate, typebox: Format.IsDate }],
]);

/** Keywords that describe a schema without changing what it accepts. */
const ANNOTATIONS = new Set([
	"type",
	"format",
	"title",
	"description",
	"default",
	"examples",
	"$id",
	"$comment",
	"readOnly",
	"writeOnly",
	"deprecated",
]);

/**
 * The fast check for `schema`, when it is a string of a format that has one
 * and nothing else checks it, and when that format is still checked by
 * TypeBox's own function, which a compiled validator takes when it is
 * compiled (an application may replace it with `Format.Set`).
 * @internal
 */
export function fastFormatOf(
	schema: TSchema,
): ((value: string) => boolean) | undefined {
	const { type, format } = schema as { type?: unknown; format?: unknown };
	if (type !== "string" || typeof format !== "string") return undefined;
	const entry = FAST_FORMATS.get(format);
	if (entry === undefined || Format.Get(format) !== entry.typebox) {
		return undefined;
	}
	for (const key of Object.keys(schema)) {
		if (!ANNOTATIONS.has(key)) return undefined;
	}
	return entry.fast;
}
