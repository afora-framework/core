import type { AnyBlueprint } from "../blueprint/types/blueprint.interface";
import { toOpenAPI } from "../openapi/openapi";
import type { OpenAPISchema } from "../openapi/types/openapi.interface";
import type { FormParts } from "./types/http.interface";

/** How a key of a multipart body is read. */
type FieldKind =
	/** One value: a file as it is, or text coerced to the scalar the field takes. */
	| { readonly kind: "one"; readonly types: readonly string[] }
	/** A list: one entry per value of the key, each read as `item`. */
	| { readonly kind: "list"; readonly item: FieldKind }
	/** An object, or any JSON: its text is parsed as JSON. */
	| { readonly kind: "json" };

interface FormShape {
	/** The keys of files, a list of them included; empty when the input has none. */
	readonly files: readonly string[];
	readonly fields: Readonly<Record<string, FieldKind>>;
}

/** A part of a multipart body: text, or a file (any other value is kept as it is). */
type Entry = unknown;

const SCALARS = new Set(["string", "number", "integer", "boolean", "null"]);

/** Whether `schema` describes a file: a binary string. */
function isFileSchema(schema: OpenAPISchema | undefined): boolean {
	return schema?.format === "binary";
}

function kindOf(schema: OpenAPISchema): FieldKind {
	const types = [schema.type ?? []].flat();
	if (isFileSchema(schema)) return { kind: "one", types: ["string"] };
	if (types.length === 1 && types[0] === "array" && schema.items) {
		const item = kindOf(schema.items);
		// A list of lists is sent as JSON, a single text.
		return item.kind === "list" ? { kind: "json" } : { kind: "list", item };
	}
	if (types.length > 0 && types.every((type) => SCALARS.has(type))) {
		return { kind: "one", types };
	}
	if (schema.enum !== undefined || schema.const !== undefined) {
		return { kind: "one", types: types.length > 0 ? types : ["string"] };
	}
	return { kind: "json" };
}

const shapes = new WeakMap<object, FormShape>();

/** What a multipart body of `blueprint` holds, by key; made once per blueprint. */
function shapeOf(blueprint: AnyBlueprint): FormShape {
	let shape = shapes.get(blueprint);
	if (!shape) {
		const schema = toOpenAPI(blueprint) as OpenAPISchema;
		const files: string[] = [];
		const fields: Record<string, FieldKind> = {};
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			if (isFileSchema(property) || isFileSchema(property.items)) {
				files.push(key);
			}
			fields[key] = kindOf(property);
		}
		shape = Object.freeze({
			files: Object.freeze(files),
			fields: Object.freeze(fields),
		});
		shapes.set(blueprint, shape);
	}
	return shape;
}

/**
 * The keys of `blueprint` that hold a file (`format: "binary"`), or a list
 * of files: the input of an HTTP route with any is read from a
 * `multipart/form-data` body.
 * @internal
 */
export function fileKeysOf(blueprint: AnyBlueprint): readonly string[] {
	return shapeOf(blueprint).files;
}

/** `text` as a field of `types` takes it; invalid text is kept for the blueprint to reject. */
function coerce(text: string, types: readonly string[]): unknown {
	if (types.includes("string")) return text;
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
	if (types.includes("null") && trimmed === "null") return null;
	return text;
}

function read(entry: Entry, kind: FieldKind): unknown {
	if (typeof entry !== "string") return entry;
	if (kind.kind === "json") {
		try {
			return JSON.parse(entry);
		} catch {
			// Not JSON: the text as sent, for the blueprint to reject.
			return entry;
		}
	}
	return kind.kind === "one" ? coerce(entry, kind.types) : entry;
}

/**
 * The input a `multipart/form-data` body sends for `blueprint`: a file part
 * as the `File` it is; a text part coerced to the number or boolean the
 * field takes, or parsed as JSON for an object (an invalid one is kept as
 * text for the blueprint to reject); every part of a repeated key as the
 * items of a list field (one part is a list of one; a list of objects may
 * also be one JSON text). A key the blueprint
 * does not declare keeps its first part, for the blueprint to reject.
 * @internal
 */
export function formInputOf(
	blueprint: AnyBlueprint,
	form: FormParts,
): Record<string, unknown> {
	const { fields } = shapeOf(blueprint);
	const input: Record<string, unknown> = {};
	for (const key of new Set(form.keys())) {
		const entries = form.getAll(key);
		const kind = Object.hasOwn(fields, key) ? fields[key] : undefined;
		let value: unknown;
		if (kind === undefined) {
			value = entries[0];
		} else if (kind.kind === "list") {
			const [only] = entries;
			// A list of objects may come as one JSON text, the whole list.
			const whole =
				entries.length === 1 && kind.item.kind === "json"
					? read(only, kind.item)
					: undefined;
			value = Array.isArray(whole)
				? whole
				: entries.map((entry) => read(entry, kind.item));
		} else {
			value = read(entries[0], kind);
		}
		// As `JSON.parse` does: `__proto__` is a key like any other.
		Object.defineProperty(input, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return input;
}

/** Whether a `content-type` header names `multipart/form-data`. */
export function isMultipart(contentType: string | undefined): boolean {
	return (
		contentType !== undefined &&
		/^\s*multipart\/form-data\s*(?:;|$)/i.test(contentType)
	);
}
