/**
 * The keys of the single-table layout and the encoding of unique values.
 *
 * - entity: `pk = E#<context.name>`,       `sk = <id>`
 * - marker: `pk = U#<context.name>#<key>`, `sk = markerOf(value)`
 */

/** The partition of the entities of a repository. */
export const entityPk = (name: string): string => `E#${name}`;

/** The partition of the markers of one unique key of a repository. */
export const uniquePk = (name: string, key: string): string =>
	`U#${name}#${key}`;

/** The largest sort key DynamoDB takes, in bytes of UTF-8. */
export const MAX_SORT_KEY_BYTES = 1024;

export const isPresent = (value: unknown): boolean =>
	value !== undefined && value !== null;

/**
 * `value` with object keys sorted and `undefined` left out (as JSON does),
 * so equal values (by structure, as `sameValue` compares them) encode alike.
 */
function canonical(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value))
		return value.map((item) => (item === undefined ? null : canonical(item)));
	if (typeof value === "object" && value !== null) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) sorted[key] = canonical(item);
		}
		return sorted;
	}
	return value;
}

/**
 * The sort key of the marker of a unique value: its JSON with object keys
 * sorted, so `1` (`1`) and `"1"` (`"1"`) are apart, and `{ a, b }` and
 * `{ b, a }` are the same value.
 */
export function markerOf(value: unknown): string {
	return JSON.stringify(canonical(value)) ?? "null";
}

/**
 * The markers an entity holds, as one string stored on its item (`m`): the
 * encoded value of each present unique key but `id`. A write conditions on
 * it, so markers are moved from the values the item still holds.
 */
export function markersOf(
	data: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): string {
	const markers: Record<string, string> = {};
	for (const key of keys) {
		if (isPresent(data[key])) markers[key] = markerOf(data[key]);
	}
	return JSON.stringify(markers);
}

/**
 * A copy of `value` DynamoDB can store: `undefined` left out of objects (and
 * `null` in arrays, as JSON), dates as ISO 8601 strings.
 */
export function storable(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value))
		return value.map((item) => (item === undefined ? null : storable(item)));
	if (typeof value === "object" && value !== null) {
		const copy: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) copy[key] = storable(item);
		}
		return copy;
	}
	return value;
}

/** The size in bytes of `text` as UTF-8. */
export const byteLength = (text: string): number =>
	new TextEncoder().encode(text).length;
