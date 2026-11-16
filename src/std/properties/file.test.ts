import { describe, expect, test } from "bun:test";
import { propertyLineageOf } from "../../experimental";
import {
	blueprintOf,
	EntityHoldsFile,
	entityOf,
	FileProperty,
	fileOf,
	InvalidFile,
	InvalidFileOptions,
	InvalidRecordDeclaration,
	jsonSchemaOf,
	listOf,
	recordOf,
	toOpenAPI,
} from "../../index";

const png = (size = 3, type = "image/png") =>
	new File([new Uint8Array(size)], "a.png", { type });

describe("FileProperty", () => {
	test("takes any Blob as it is, never a copy", () => {
		const file = png();
		expect(new FileProperty(file).value).toBe(file);
		const blob = new Blob(["x"]);
		expect(FileProperty.safeParse(blob)).toEqual({ value: blob as File });
	});

	test("rejects what is not a file with InvalidFile", () => {
		for (const value of ["a.png", {}, new Uint8Array(1), null]) {
			const result = FileProperty.safeParse(value);
			expect(result.issues?.[0]?.message).toBe("Expected a file");
		}
		expect(() => new FileProperty("x" as never)).toThrow(InvalidFile);
	});

	test("has an empty file as its demo, made when asked", () => {
		const demo = FileProperty.demo().value;
		expect(demo).toBeInstanceOf(File);
		expect(demo.size).toBe(0);
		expect(FileProperty.demo().value).not.toBe(demo);
	});
});

describe("fileOf", () => {
	const Image = fileOf({ types: ["image/png", "image/svg+xml"], maxBytes: 4 });

	test("checks the media type, without its parameters, and the size", () => {
		expect(Image.safeParse(png(4)).issues).toBeUndefined();
		expect(
			Image.safeParse(png(1, "IMAGE/SVG+XML; charset=utf-8")).issues,
		).toBeUndefined();
		expect(Image.safeParse(png(1, "text/plain")).issues?.[0]?.message).toBe(
			'Expected a file of type image/png, image/svg+xml, not "text/plain"',
		);
		expect(Image.safeParse(png(1, "")).issues?.[0]?.message).toBe(
			"Expected a file of type image/png, image/svg+xml, not a file of unknown type",
		);
		expect(Image.safeParse(png(5)).issues?.[0]?.message).toBe(
			"Expected a file of at most 4 bytes, not 5 bytes",
		);
	});

	test("takes wildcards such as image/*", () => {
		const Any = fileOf({ types: ["image/*"] });
		expect(Any.safeParse(png(1, "image/webp")).issues).toBeUndefined();
		expect(Any.safeParse(png(1, "video/mp4")).issues).toHaveLength(1);
		expect(Any.demo().value.type).toBe("image/octet-stream");
		// An SVG is a document that can carry scripts: only its own name takes it.
		expect(Any.safeParse(png(1, "image/svg+xml")).issues).toHaveLength(1);
		const Svg = fileOf({ types: ["image/*", "image/svg+xml"] });
		expect(Svg.safeParse(png(1, "image/svg+xml")).issues).toBeUndefined();
	});

	test("rejects options that are not media types or a size", () => {
		expect(() => fileOf({ types: [] })).toThrow(InvalidFileOptions);
		expect(() => fileOf({ types: ["png"] })).toThrow(InvalidFileOptions);
		expect(() => fileOf({ maxBytes: -1 })).toThrow(InvalidFileOptions);
		expect(() => fileOf({ maxBytes: 1.5 })).toThrow(InvalidFileOptions);
	});

	test("records its arguments, for codegen", () => {
		expect(propertyLineageOf(Image)).toEqual({
			kind: "factory",
			factory: "fileOf",
			args: { types: ["image/png", "image/svg+xml"], maxBytes: 4 },
		});
	});

	test("is a binary string in OpenAPI and JSON Schema", () => {
		const Upload = blueprintOf((ctx) => ({
			file: ctx.fileOf({ types: ["image/png"] }),
			files: ctx.list.optional.file,
		}));
		expect(toOpenAPI(Upload)).toEqual({
			type: "object",
			properties: {
				file: {
					type: "string",
					format: "binary",
					contentMediaType: "image/png",
				},
				files: { type: "array", items: { type: "string", format: "binary" } },
			},
			required: ["file"],
			additionalProperties: false,
		});
		expect(
			(jsonSchemaOf(Upload) as { properties: Record<string, unknown> })
				.properties.file,
		).toEqual({
			type: "string",
			format: "binary",
			contentMediaType: "image/png",
		});
	});

	test("a record holds the file as it is, in toJSON too", () => {
		const Media = recordOf(
			blueprintOf((ctx) => ({ file: ctx.fileOf({ types: ["image/png"] }) })),
		);
		const file = png();
		const media = new Media({ file });
		expect(media.file).toBe(file);
		expect(media.toJSON().file).toBe(file);
		expect(Media.safeParse({ file: "x" }).issues?.[0]?.path).toEqual(["file"]);
	});
});

describe("a file in a record or an entity", () => {
	test("cannot be sensitive or unique", () => {
		const Upload = blueprintOf((ctx) => ({
			file: ctx.file,
			files: ctx.list.file,
			title: ctx.string,
		}));
		expect(() => recordOf(Upload, { sensitive: ["file"] })).toThrow(
			'"file" holds a file, which cannot be sensitive.',
		);
		expect(() => recordOf(Upload, { unique: ["files"] as never })).toThrow(
			InvalidRecordDeclaration,
		);
		expect(() => recordOf(Upload, { sensitive: ["title"] })).not.toThrow();
	});

	test("an entity cannot hold one, at any depth", () => {
		const Media = recordOf(blueprintOf((ctx) => ({ file: ctx.file })));
		for (const blueprint of [
			blueprintOf((ctx) => ({ file: ctx.file })),
			blueprintOf((ctx) => ({ files: listOf(ctx.fileOf({ maxBytes: 1 })) })),
			blueprintOf(() => ({
				nested: blueprintOf((ctx) => ({ file: ctx.file })),
			})),
			blueprintOf(() => ({ media: Media })),
		]) {
			expect(() => entityOf(blueprint as never)).toThrow(EntityHoldsFile);
		}
		expect(() =>
			entityOf(
				blueprintOf(() => ({
					nested: blueprintOf((ctx) => ({ file: ctx.file })),
				})),
				{
					name: "Post",
				},
			),
		).toThrow('"nested.file" of entity "Post" holds a file');
	});
});
