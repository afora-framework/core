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

/** The most parts a multipart body may have, unless `maxParts` says otherwise. */
export const DEFAULT_MAX_PARTS = 1000;

/** Thrown by `formInputOf` for a body with more parts than allowed. */
export class TooManyParts extends Error {
	constructor(readonly maxParts: number) {
		super(`The body has more than ${maxParts} parts.`);
	}
}

/**
 * The input a `multipart/form-data` body sends for `blueprint`: a file part
 * as the `File` it is; a text part coerced to the number or boolean the
 * field takes, or parsed as JSON for an object (an invalid one is kept as
 * text for the blueprint to reject); every part of a repeated key as the
 * items of a list field (one part is a list of one; a list of objects may
 * also be one JSON text). The parts are walked once. Of the keys the
 * blueprint does not declare, only the first is kept (its first part), for
 * the blueprint to reject; the others are dropped unread. Throws
 * `TooManyParts` past `maxParts` parts.
 * @internal
 */
export function formInputOf(
	blueprint: AnyBlueprint,
	form: FormParts,
	maxParts: number = DEFAULT_MAX_PARTS,
): Record<string, unknown> {
	const { fields } = shapeOf(blueprint);
	const grouped = new Map<string, unknown[]>();
	let undeclared: [string, unknown] | undefined;
	let count = 0;
	for (const [key, entry] of form.entries()) {
		if (++count > maxParts) throw new TooManyParts(maxParts);
		if (!Object.hasOwn(fields, key)) {
			undeclared ??= [key, entry];
			continue;
		}
		const entries = grouped.get(key);
		if (entries) entries.push(entry);
		else grouped.set(key, [entry]);
	}
	const input: Record<string, unknown> = {};
	// As `JSON.parse` does: `__proto__` is a key like any other.
	const put = (key: string, value: unknown) =>
		Object.defineProperty(input, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	for (const [key, entries] of grouped) {
		const kind = fields[key] as FieldKind;
		if (kind.kind === "list") {
			const [only] = entries;
			// A list of objects may come as one JSON text, the whole list.
			const whole =
				entries.length === 1 && kind.item.kind === "json"
					? read(only, kind.item)
					: undefined;
			put(
				key,
				Array.isArray(whole)
					? whole
					: entries.map((entry) => read(entry, kind.item)),
			);
		} else {
			put(key, read(entries[0], kind));
		}
	}
	if (undeclared) put(undeclared[0], undeclared[1]);
	return input;
}

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const at = (bytes: Uint8Array, offset: number, expected: readonly number[]) =>
	expected.every((byte, index) => bytes[offset + index] === byte);

/**
 * The image types whose first bytes are checked against the type a client
 * declares: a file sent as one of them that does not start as one is
 * refused, so a renamed script or SVG is not taken for a PNG.
 */
const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
	"image/png": (bytes) =>
		at(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	"image/jpeg": (bytes) => at(bytes, 0, [0xff, 0xd8, 0xff]),
	"image/gif": (bytes) =>
		at(bytes, 0, ascii("GIF87a")) || at(bytes, 0, ascii("GIF89a")),
	"image/webp": (bytes) =>
		at(bytes, 0, ascii("RIFF")) && at(bytes, 8, ascii("WEBP")),
	"image/avif": (bytes) =>
		at(bytes, 4, ascii("ftyp")) &&
		["avif", "avis"].some((brand) => {
			for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
				if (at(bytes, offset, ascii(brand))) return true;
			}
			return false;
		}),
};

/** The essence of a media type: without parameters, in lower case. */
function essenceOf(type: string): string {
	return type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * The 400 problem for the first file of `input` (a top-level key, or an item
 * of one) whose declared type is a PNG, JPEG, GIF, WebP or AVIF image and
 * whose first bytes are not; `undefined` when every such file is what it
 * says. Reads at most 32 bytes of each.
 * @internal
 */
export async function contentMismatchOf(
	input: Readonly<Record<string, unknown>>,
): Promise<object | undefined> {
	for (const [key, value] of Object.entries(input)) {
		const items = Array.isArray(value) ? value : [value];
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (typeof Blob === "undefined" || !(item instanceof Blob)) continue;
			const type = essenceOf(item.type);
			const matches = Object.hasOwn(SIGNATURES, type)
				? SIGNATURES[type]
				: undefined;
			if (!matches) continue;
			const bytes = new Uint8Array(await item.slice(0, 32).arrayBuffer());
			if (matches(bytes)) continue;
			const message = `Expected the content of a file of type ${type}, which this file does not start with`;
			return {
				type: "urn:afora:exception:InvalidFileContent",
				title: "InvalidFileContent",
				status: 400,
				detail: message,
				issues: [
					{
						path: Array.isArray(value) ? [key, index] : [key],
						code: "invalid_value",
						message,
					},
				],
			};
		}
	}
	return undefined;
}

/**
 * Whether a `content-type` header names JSON: `application/json` or an
 * `application/*+json` type, with any parameters.
 * @internal
 */
export function isJson(contentType: string): boolean {
	const type = essenceOf(contentType);
	if (type === "application/json") return true;
	if (!type.startsWith("application/") || !type.endsWith("+json")) return false;
	const subtype = type.slice("application/".length, -"+json".length);
	return subtype !== "" && !subtype.includes("/");
}

/** Whether a `content-type` header names `multipart/form-data`. */
export function isMultipart(contentType: string | undefined): boolean {
	return (
		contentType !== undefined &&
		/^\s*multipart\/form-data\s*(?:;|$)/i.test(contentType)
	);
}
