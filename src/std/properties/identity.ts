import slugify from "slugify";
import { Type } from "typebox";
import { idOf, vouchedIdOf } from "../../core/entity/id";
import { propertyOf } from "../../core/property/property";
import { generateId, makesDefaultIds } from "../runtime";

const UUID_V7 =
	"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** A UUID v7, time-ordered, so ids sort by creation. */
export class Id extends propertyOf({
	name: "id",
	schema: Type.String({ pattern: UUID_V7 }),
	default: "01a173d2-051c-77bb-8166-a371e999573e",
	preHandle: (value) => value.toLowerCase(),
}) {
	/** A new id from the configured generator (portable UUID v7 by default). */
	static generate(): Id {
		return new Id(generateId());
	}
}

const ANY_UUID =
	"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** A UUID of any version, in lower case. */
export class UuidKey extends propertyOf({
	name: "uuid",
	schema: Type.String({ pattern: ANY_UUID }),
	default: "6f1c2b9e-3d4a-4e8b-9f2a-1c3b5d7e9f0a",
	preHandle: (value) => value.toLowerCase(),
}) {}

/** Any text of 1 to 256 characters, kept as given: a natural key, e.g. `profile`. */
export class TextKey extends propertyOf({
	name: "key",
	schema: Type.String({ minLength: 1, maxLength: 256 }),
	default: "profile",
}) {}

/**
 * The `id` option of an entity whose ids are UUIDs of any version (a v4
 * loaded from an existing database included), lower-cased; a new entity
 * still gets a UUID v7 from the configured generator, e.g.
 * `entityOf(Legacy, { id: Uuid })`.
 */
export const Uuid = vouchedIdOf(
	UuidKey,
	generateId,
	// The default generator makes a lower-case UUID v7, which `UuidKey` keeps.
	makesDefaultIds,
);

/**
 * The `id` option of an entity whose id is a natural key: any text of 1 to
 * 256 characters, never generated, so the input of the entity must hold it,
 * e.g. `entityOf(Setting, { id: Key })` and `new Setting({ id: "seo", ... })`.
 */
export const Key = idOf(TextKey);

/**
 * A URL-friendly identifier, e.g. `ola-mundo`: any text given is slugified,
 * lower-cased and stripped of special characters. A record lists every
 * `Slug` key in `options.unique`.
 */
export class Slug extends propertyOf({
	name: "slug",
	schema: Type.String({
		pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
		maxLength: 255,
	}),
	default: "demo-slug",
	unique: true,
	preHandle: (value) =>
		slugify(value, { lower: true, strict: true, trim: true }),
}) {}
