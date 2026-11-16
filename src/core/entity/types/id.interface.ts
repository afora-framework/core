import type { ParseResult } from "../../parse/types/parse.interface";
import type { AnyPropertyConstructor } from "../../property/types/property-collection.type";
import type { IEntityIdentity } from "./entity.interface";

/** The value of an id at run time: a string, or a number a database assigns. */
export type IdValue = string | number;

/** The value `Property` gives, the type of the ids it validates. */
export type IdValueOf<Property> = Property extends {
	safeParse(value: unknown): ParseResult<infer Value>;
}
	? Value
	: never;

/**
 * How the entities of one class get their id, made by `idOf`: `property`
 * validates it, and `generate`, when `Generated` is `true`, makes it for an
 * entity built without one. When `Generated` is `"database"` (`Serial`),
 * the database assigns it: `repository.create` sets it on the entity.
 */
export interface IdStrategy<
	Property extends AnyPropertyConstructor = AnyPropertyConstructor,
	Generated extends boolean | "database" = boolean | "database",
> {
	/** The property of `id`, which replaces the one of the identity. */
	readonly property: Property;
	/** Makes the id of an entity built without one; none for a natural key. */
	readonly generate: Generated extends true
		? () => IdValueOf<Property>
		: undefined;
	/**
	 * `"database"` when the database assigns the id as it stores the entity
	 * (`Serial`): built without one, the entity has none until
	 * `repository.create`, which only a provider with
	 * `capabilities.generatedIds` runs.
	 */
	readonly generatedBy?: Generated extends "database" ? "database" : undefined;
}

/** `Identity`, with the property of the strategy `Id` as its `id`. */
export type IdentityWithId<Identity extends IEntityIdentity, Id> =
	Id extends IdStrategy<infer Property>
		? {
				readonly [Key in keyof Identity]: Key extends "id"
					? Property
					: Identity[Key];
			}
		: Identity;

/** `{ readonly id: ... }`, required, when the strategy `Id` makes no id. */
export type RequiredIdInput<Id> =
	Id extends IdStrategy<infer Property, false>
		? { readonly id: IdValueOf<Property> }
		: unknown;
