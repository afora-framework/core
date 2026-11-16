import { ExceptionLayers } from "../../core/exception/enums/exception-layers";
import { exceptionOf } from "../../core/exception/exception";
import { markExported } from "../../core/exception/exported";
import type { Issue } from "../../core/parse/types/parse.interface";

/**
 * JSON data that its JSON Schema rejects, or that is not JSON at all, as
 * `checkJsonSchema` finds it; `details.issues` says where and why (so
 * `statusOf` gives 400).
 */
export const InvalidJsonData = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "InvalidJsonData",
	message: ({ issues }: { readonly issues: readonly Issue[] }, source) =>
		`Invalid JSON data for "${source}": ${issues
			.map(
				(issue) =>
					`${issue.path.length === 0 ? "/" : `/${issue.path.join("/")}`}: ${issue.message}`,
			)
			.join("; ")}`,
});

/** A schema given to `jsonOf` or `checkJsonSchema` that is not a JSON Schema (draft 2020-12). */
export const InvalidJsonSchema = exceptionOf({
	layer: ExceptionLayers.Schema,
	name: "InvalidJsonSchema",
	message: (_, source) => `The schema of "${source}" is not a JSON Schema.`,
});

markExported(InvalidJsonData, InvalidJsonSchema);

/**
 * A value a file property (`FileProperty`, `fileOf`) rejects: not a file, of
 * a media type it does not accept, or larger than its `maxBytes`. Its
 * message is the issue's, so `statusOf` gives 400 with the issue at the key.
 */
export const InvalidFile = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "InvalidFile",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** Options of `fileOf` that are not valid: `types` not media types, or `maxBytes` not a size. */
export const InvalidFileOptions = exceptionOf({
	layer: ExceptionLayers.Schema,
	name: "InvalidFileOptions",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid options for the file property "${source}": ${reason}`,
});

/** `Url.with({ protocols })` got protocols that are not URL schemes, such as `"https"` without its colon. */
export const InvalidUrlOptions = exceptionOf({
	layer: ExceptionLayers.Schema,
	name: "InvalidUrlOptions",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid options for the URL property "${source}": ${reason}`,
});

markExported(InvalidFile, InvalidFileOptions, InvalidUrlOptions);
