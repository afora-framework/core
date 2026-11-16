import type { AnyPropertyConstructor } from "../property/types/property-collection.type";
import { InvalidIdStrategy } from "./exceptions";
import type { IdStrategy, IdValue, IdValueOf } from "./types/id.interface";

/** Under this key, an id strategy holds when the ids it makes are known to be valid. */
const VouchedIds = Symbol("vouchedIds");

/** What an id strategy holds, at run time. @internal */
interface IdStrategyInternals {
	readonly [VouchedIds]?: () => boolean;
}

/**
 * How the entities of one class get their id, for the `id` option of
 * `entityOf`: `property` validates it (it replaces the `id` of the identity
 * and stays unique) and `generate`, when given, makes it for an entity built
 * without one. Without `generate`, the id is a natural key: the input of the
 * entity must hold it, or building it reports an issue at `id`.
 *
 * @example
 * ```ts
 * import { blueprintOf, entityOf, idOf, Integer } from "@afora/core";
 *
 * let next = 0;
 * class Ticket extends entityOf(
 * 	blueprintOf((ctx) => ({ title: ctx.string })),
 * 	{ id: idOf(Integer, () => ++next) },
 * ) {}
 *
 * new Ticket({ title: "First" }).id; // 1
 * ```
 */
export function idOf<const Property extends AnyPropertyConstructor>(
	property: Property,
): IdStrategy<Property, false>;
export function idOf<const Property extends AnyPropertyConstructor>(
	property: Property,
	generate: () => IdValueOf<Property>,
): IdStrategy<Property, true>;
export function idOf(
	property: AnyPropertyConstructor,
	generate?: () => unknown,
): IdStrategy {
	return strategyOf(property, generate, undefined);
}

/**
 * `idOf`, with `vouched` telling when what `generate` is about to make is
 * one `property` accepts as it is, so that the entity does not check it
 * again (as `std` does of the runtime generator of UUIDs).
 * @internal
 */
export function vouchedIdOf<const Property extends AnyPropertyConstructor>(
	property: Property,
	generate: () => IdValueOf<Property>,
	vouched: () => boolean,
): IdStrategy<Property, true> {
	return strategyOf(property, generate, vouched) as IdStrategy<Property, true>;
}

/**
 * The strategy of an id the database assigns as it stores the entity, which
 * `property` validates (as `Serial` of `std`): an entity built without one
 * has none until `repository.create` stores it.
 * @internal
 */
export function databaseIdOf<const Property extends AnyPropertyConstructor>(
	property: Property,
): IdStrategy<Property, "database"> {
	return strategyOf(property, undefined, undefined, true) as IdStrategy<
		Property,
		"database"
	>;
}

function strategyOf(
	property: AnyPropertyConstructor,
	generate: (() => unknown) | undefined,
	vouched: (() => boolean) | undefined,
	database = false,
): IdStrategy {
	const fail = (reason: string): never => {
		throw new InvalidIdStrategy({ source: "idOf", details: { reason } });
	};
	if (
		typeof property !== "function" ||
		typeof (property as { type?: unknown }).type !== "object"
	) {
		fail("expected a property, made by propertyOf.");
	}
	if (property.type.optional === true) {
		fail("the property of an id cannot be optional.");
	}
	if (generate !== undefined && typeof generate !== "function") {
		fail("expected generate to be a function.");
	}
	const strategy: IdStrategy & IdStrategyInternals = database
		? { property, generate, generatedBy: "database" }
		: { property, generate };
	if (vouched) Object.defineProperty(strategy, VouchedIds, { value: vouched });
	Object.freeze(strategy);
	strategies.add(strategy);
	return strategy;
}

/** Every strategy `idOf` made. */
const strategies = new WeakSet<object>();

/** Whether `value` is an id strategy, made by `idOf`. */
export function isIdStrategy(value: unknown): value is IdStrategy {
	return typeof value === "object" && value !== null && strategies.has(value);
}

/** When the ids `strategy` makes are known to be valid, if ever. @internal */
export function vouchedIdsOf(
	strategy: IdStrategy,
): (() => boolean) | undefined {
	return (strategy as IdStrategyInternals)[VouchedIds];
}

/** Whether `value` can be an id: a string, or a finite number. */
export function isIdValue(value: unknown): value is IdValue {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}
