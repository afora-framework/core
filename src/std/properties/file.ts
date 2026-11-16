import { type TOptional, type TUnsafe, Type } from "typebox";
import { recordPropertyLineage } from "../../core/property/lineage";
import { type PropertyClass, propertyOf } from "../../core/property/property";
import { Demo } from "../../core/symbols/demo";
import { InvalidFile, InvalidFileOptions } from "./exceptions";

/** The schema of a file: `format: "binary"`, which OpenAPI documents as a binary string. */
export type TFile = TUnsafe<File>;

/** A class declared with `fileOf`. */
export type FileClass<Optional extends boolean = false> = PropertyClass<
	Optional extends true ? TOptional<TFile> : TFile,
	File
>;

/** What `fileOf` takes. */
export interface FileOptions<Optional extends boolean = false> {
	/**
	 * The media types accepted, as `"image/png"` or `"image/*"`; any type when
	 * absent. Compared with the type of the file, without its parameters.
	 */
	readonly types?: readonly string[];
	/** The largest size accepted, in bytes. */
	readonly maxBytes?: number;
	readonly name?: string;
	readonly optional?: Optional;
}

/** The media type `type` without its parameters, in lower case. */
function essenceOf(type: string): string {
	return type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Whether the media type `type` is one of `accepted`, where `image/*` takes any image. */
function accepts(accepted: readonly string[], type: string): boolean {
	const essence = essenceOf(type);
	return accepted.some((pattern) => {
		const wanted = essenceOf(pattern);
		return wanted.endsWith("/*")
			? essence.startsWith(wanted.slice(0, -1))
			: essence === wanted;
	});
}

/** The check of a file property: throws `InvalidFile` for a value it rejects. */
function checkFile(
	source: string,
	accepted: readonly string[] | undefined,
	maxBytes: number | undefined,
): (value: File) => File {
	const reject = (reason: string): never => {
		throw new InvalidFile({ source, details: { reason } });
	};
	return (value) => {
		// Looked up when a value comes, never when the module loads.
		if (typeof Blob === "undefined" || !(value instanceof Blob)) {
			return reject("Expected a file");
		}
		if (accepted && !accepts(accepted, value.type)) {
			const type = essenceOf(value.type);
			reject(
				`Expected a file of type ${accepted.join(", ")}, not ${type === "" ? "a file of unknown type" : `"${type}"`}`,
			);
		}
		if (maxBytes !== undefined && value.size > maxBytes) {
			reject(
				`Expected a file of at most ${maxBytes} bytes, not ${value.size} bytes`,
			);
		}
		return value;
	};
}

/**
 * Gives `Property` an empty file of `type` as its demo value, made when it is
 * asked for, so no `File` is made when the module loads.
 */
function demoFile<Property extends { readonly type: object }>(
	Property: Property,
	type: string,
): Property {
	Object.defineProperty(Property.type, Demo, {
		get: () => new File([], "demo", { type }),
		enumerable: true,
		configurable: true,
	});
	return Property;
}

function invalidOptions(source: string, reason: string): never {
	throw new InvalidFileOptions({ source, details: { reason } });
}

/**
 * A file, as `multipart/form-data` gives it (a `File`, or any `Blob`):
 * checked to be one, of one of `types` (`image/*` takes any image) and of
 * at most `maxBytes`, and kept as it is, never copied or read. Its schema is
 * `format: "binary"`, so an HTTP sink reads `multipart/form-data` for an
 * input that holds one and OpenAPI documents it as a binary string. A file
 * cannot be `sensitive` or `unique`; a record's `toJSON` gives it as it is,
 * and `JSON.stringify` writes a `Blob` as `{}`.
 *
 * @example
 * ```ts
 * import { fileOf } from "@afora/core";
 *
 * const Avatar = fileOf({ types: ["image/png", "image/jpeg"], maxBytes: 5_000_000 });
 * ```
 */
export function fileOf<Optional extends boolean = false>(
	options: FileOptions<Optional> = {},
): FileClass<Optional> {
	const { types, maxBytes, name = "file", optional } = options;
	if (
		types !== undefined &&
		(!Array.isArray(types) ||
			types.length === 0 ||
			types.some(
				(type) => typeof type !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(type),
			))
	) {
		invalidOptions(
			name,
			'expected "types" to be a non-empty list of media types, as "image/png" or "image/*".',
		);
	}
	if (
		maxBytes !== undefined &&
		(!Number.isInteger(maxBytes) || (maxBytes as number) < 0)
	) {
		invalidOptions(
			name,
			'expected "maxBytes" to be a whole number of bytes, 0 or more.',
		);
	}
	const accepted = types ? Object.freeze([...types]) : undefined;
	const Property = propertyOf({
		name,
		schema: Type.Unsafe<File>({
			format: "binary",
			...(accepted?.length === 1 && !accepted[0]?.endsWith("/*")
				? { contentMediaType: accepted[0] }
				: {}),
		}),
		optional,
		preHandle: checkFile(name, accepted, maxBytes),
	});
	const [first = "application/octet-stream"] = accepted ?? [];
	demoFile(Property, first.replace(/\*$/, "octet-stream"));
	recordPropertyLineage(Property, {
		kind: "factory",
		factory: "fileOf",
		args: Object.freeze({
			...(accepted ? { types: accepted } : {}),
			...(maxBytes === undefined ? {} : { maxBytes }),
			...(name === "file" ? {} : { name }),
			...(optional ? { optional: true } : {}),
		}),
	});
	return Property as unknown as FileClass<Optional>;
}

/** Any file (a `File` or a `Blob`), of any type and size; `fileOf` for limits. */
export const FileProperty = demoFile(
	propertyOf({
		name: "file",
		schema: Type.Unsafe<File>({ format: "binary" }),
		preHandle: checkFile("file", undefined, undefined),
	}),
	"application/octet-stream",
);
