import slugify from "slugify";
import { Type } from "typebox";
import { propertyOf } from "../../core/property/property";
import { generateId } from "../runtime";

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
