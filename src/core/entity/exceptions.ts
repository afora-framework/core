import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/**
 * A blueprint key of an entity takes the name of a key of its identity (`id`,
 * `createdAt`, `updatedAt`, `deletedAt`) or of a member of the entity;
 * `source` is the entity name.
 */
export const ReservedEntityKey = exceptionOf({
	layer: ExceptionLayers.Entity,
	name: "ReservedEntityKey",
	message: ({ key }: { readonly key: string }, source) =>
		`"${key}" is a key or a member of every entity and cannot be a key of the blueprint of "${source}".`,
});

/**
 * A key of the identity of an entity is changed by `set`, or listed in
 * `change`; the entity keeps it. `source` is the entity name.
 */
export const ImmutableEntityKey = exceptionOf({
	layer: ExceptionLayers.Entity,
	name: "ImmutableEntityKey",
	message: ({ key }: { readonly key: string }, source) =>
		`"${key}" of entity "${source}" cannot be changed.`,
});

/** A destroyed entity is changed, or destroyed again; `source` is the entity name. */
export const DeletedEntity = exceptionOf({
	layer: ExceptionLayers.Entity,
	name: "DeletedEntity",
	message: ({ id }: { readonly id: string }, source) =>
		`Entity "${source}" of id "${id}" was destroyed and cannot change.`,
});

/**
 * The `expires` option of an entity is invalid: `at` names no date key of its
 * blueprint, `after` is not a duration of positive numbers, or the entity
 * builder has no `expiresAt` field; `source` is the entity name.
 */
export const InvalidEntityExpiry = exceptionOf({
	layer: ExceptionLayers.Entity,
	name: "InvalidEntityExpiry",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid expires of entity "${source}": ${reason}`,
});

/**
 * The schema evolution options of an entity are invalid: `schemaVersion` is
 * not a positive integer, a step of `upgrade` is not a function or reaches a
 * version outside `2..schemaVersion`, or `previousNames` holds something
 * that cannot name a record, or its own name; `source` is the entity name.
 */
export const InvalidEntitySchemaVersion = exceptionOf({
	layer: ExceptionLayers.Entity,
	name: "InvalidEntitySchemaVersion",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid schema evolution options of entity "${source}": ${reason}`,
});
