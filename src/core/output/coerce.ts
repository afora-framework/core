import type { AnyBlueprint } from "../blueprint/types/blueprint.interface";
import { toOpenAPI } from "../openapi/openapi";

/** What each scalar field of a blueprint takes, by key, from its OpenAPI type; made once per blueprint. */
const scalarTypes = new WeakMap<
	object,
	Readonly<Record<string, readonly string[]>>
>();

function scalarTypesOf(
	blueprint: AnyBlueprint,
): Readonly<Record<string, readonly string[]>> {
	let types = scalarTypes.get(blueprint);
	if (!types) {
		const schema = toOpenAPI(blueprint) as {
			properties?: Record<string, { type?: string | string[] }>;
		};
		const found: Record<string, readonly string[]> = {};
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			found[key] = [property.type ?? []].flat();
		}
		types = Object.freeze(found);
		scalarTypes.set(blueprint, types);
	}
	return types;
}

/** `text` as a field of `types` takes it; invalid text is kept for the blueprint to reject. */
function coerce(text: string, types: readonly string[] | undefined): unknown {
	if (!types || types.includes("string")) return text;
	const trimmed = text.trim();
	if (
		types.includes("boolean") &&
		(trimmed === "true" || trimmed === "false")
	) {
		return trimmed === "true";
	}
	if (types.includes("integer") || types.includes("number")) {
		const number = trimmed === "" ? Number.NaN : Number(trimmed);
		if (Number.isFinite(number)) return number;
	}
	return text;
}

/**
 * Text values (a query string, headers, the values of a session) as the
 * scalar fields of `blueprint` take them: a number or a boolean where the
 * field is one rather than a string, else as is, so the blueprint rejects
 * invalid text with its own issue. `undefined` values are left out. For
 * sinks, which read text from their transport.
 */
export function coerceTextValues(
	blueprint: AnyBlueprint,
	texts: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
	const types = scalarTypesOf(blueprint);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(texts)) {
		if (value !== undefined) out[key] = coerce(value, types[key]);
	}
	return out;
}
