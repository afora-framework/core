import { blueprintBuilderOf } from "../core/blueprint/blueprint";
import { entityBuilderOf } from "../core/entity/entity";
import { vouching } from "../core/entity/trust";
import { Id } from "./properties/identity";
import { CreatedAt, DeletedAt, ExpiresAt, UpdatedAt } from "./properties/time";
import { StdRecordPlugins } from "./record-plugins";
import { generateId, makesDefaultIds } from "./runtime";

/** The identity of every `std` entity. */
const Identity = blueprintBuilderOf()(() => ({
	id: Id,
	createdAt: CreatedAt,
	updatedAt: UpdatedAt,
	deletedAt: DeletedAt,
}));

/**
 * An entity of `blueprint`: a record with an `id` (a UUID v7, in
 * `options.unique`) and a `createdAt`, both made when missing from its value,
 * an `updatedAt` set by each change, and a `deletedAt` set by `destroy`, after
 * which it no longer changes; with `expires: { after }`, an `expiresAt` too.
 * E.g.
 * `class User extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}`.
 * As a record, the class can be a field of another blueprint, e.g.
 * `{ author: User }`, with `optionalOf` and `listOf`. `options.plugins` picks
 * from the standard plugins, as `(ctx) => [ctx.publishable]`, or takes any
 * plugin made by `recordPluginOf`.
 */
export const entityOf = entityBuilderOf(
	vouching(
		{
			identity: Identity,
			generateId,
			now: () => new Date().toISOString(),
			expiresAt: ExpiresAt,
			plugins: [StdRecordPlugins],
		},
		// The default id is a UUID v7 in lower case and `toISOString` a date and
		// time, which `Id` and `CreatedAt` keep as they are.
		{ id: makesDefaultIds, createdAt: () => true },
	),
);
