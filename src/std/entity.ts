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

/** The last millisecond `now` formatted, and how it came out. */
let lastMillisecond = Number.NaN;
let lastTimestamp = "";

/**
 * The current time as an ISO 8601 string. Formatting it is most of the cost of
 * a time stamp, and a loop that builds entities makes many in one millisecond,
 * so the last one is kept.
 */
function now(): string {
	const millisecond = Date.now();
	if (millisecond !== lastMillisecond) {
		lastTimestamp = new Date(millisecond).toISOString();
		lastMillisecond = millisecond;
	}
	return lastTimestamp;
}

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
 * plugin made by {@link recordPluginOf}.
 *
 * @throws {@link ReservedEntityKey} when the blueprint declares an identity key or a member of an entity.
 * @throws {@link ReservedRecordKey} when a key of the blueprint is a member of the record.
 *
 * @example
 * ```ts
 * import { blueprintOf, entityOf } from "@afora/core";
 *
 * class User extends entityOf(
 * 	blueprintOf((ctx) => ({ name: ctx.string })),
 * 	{ change: ["name"] },
 * ) {}
 *
 * const user = new User({ name: "Jane" });
 * user.id; // a UUID v7
 * user.updatedAt; // undefined until the first change
 * user.change.name("Ann").updatedAt; // now
 * user.destroy().isDeleted; // true
 * ```
 */
export const entityOf = entityBuilderOf(
	vouching(
		{
			identity: Identity,
			generateId,
			now,
			expiresAt: ExpiresAt,
			plugins: [StdRecordPlugins],
		},
		// The default id is a UUID v7 in lower case and `toISOString` a date and
		// time, which `Id` and `CreatedAt` keep as they are.
		{ id: makesDefaultIds, createdAt: () => true },
	),
);
