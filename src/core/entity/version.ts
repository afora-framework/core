import { Type } from "typebox";
import { blueprintBuilderOf } from "../blueprint/blueprint";
import { propertyOf } from "../property/property";

/**
 * The `version` of a versioned entity: a positive integer, 1 when created,
 * which each `update` of its repository checks and increments.
 */
export class EntityVersion extends propertyOf({
	name: "version",
	schema: Type.Integer({ minimum: 1 }),
	default: 1,
}) {}

/** The identity key a versioned entity adds after the others. */
export const VersionIdentity = blueprintBuilderOf()(() => ({
	version: EntityVersion,
}));
