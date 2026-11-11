import { parseField } from "../parse/parse";
import { withStandard } from "../standard/standard";
import { Kind } from "../symbols/kind";
import { InvalidBlueprintVariant } from "./exceptions";
import { isBlueprint } from "./is-blueprint";
import { isRecordClass } from "./record-field";
import type {
	AnyBlueprint,
	AnyBlueprintVariant,
	BlueprintVariants,
	IBlueprintVariant,
} from "./types/blueprint.interface";

/**
 * A field holding one of several objects, told apart by the value of `key`:
 * `variantOf("type", { click: Click, signup: Signup })` takes
 * `{ type: "click", ...a Click }` or `{ type: "signup", ...a Signup }`. Each
 * variant is a blueprint, which does not declare `key`: the field adds it,
 * with the name of the variant for its value. A variant can also be a record
 * class (an entity too): the value is then an instance of it, told apart by
 * its class, and the key is only in what is given, in `toJSON` and in what is
 * stored.
 */
export function variantOf<
	const Key extends string,
	const Variants extends BlueprintVariants,
>(key: Key, variants: Variants): IBlueprintVariant<Key, Variants> {
	const fail = (reason: string): never => {
		throw new InvalidBlueprintVariant({
			source: "blueprint",
			details: { key: String(key), reason },
		});
	};
	if (typeof key !== "string" || key === "") {
		fail("its key must be a string that is not empty");
	}
	const tags = Object.keys(variants);
	if (tags.length === 0) fail("it needs at least one variant");
	const classes = new Set<unknown>();
	for (const tag of tags) {
		const variant = variants[tag];
		if (!isBlueprint(variant) && !isRecordClass(variant)) {
			fail(`the variant "${tag}" is not a blueprint nor a record class`);
		}
		// An instance is told apart by its class, so a class names one variant.
		if (classes.has(variant)) {
			fail(`the variant "${tag}" is a class another variant already is`);
		}
		if (isRecordClass(variant)) classes.add(variant);
		if (Object.hasOwn(blueprintOfVariant(variant as Variant).properties, key)) {
			fail(`the variant "${tag}" declares "${key}", which the field adds`);
		}
	}

	return standardVariantOf({
		[Kind]: "variant" as const,
		key,
		variants: Object.freeze({ ...variants }),
		optional: false,
	}) as unknown as IBlueprintVariant<Key, Variants>;
}

/** `variant`, frozen, with the `~standard` that handles a value as `variant` does. */
export function standardVariantOf<Variant extends object>(
	variant: Variant,
): Variant {
	return Object.freeze(
		withStandard(variant, (value) =>
			parseField(
				variant as unknown as AnyBlueprintVariant,
				value,
				[],
				"variant",
			),
		),
	);
}

type Variant = BlueprintVariants[string];

/** The blueprint of a variant: itself, or that of the record class it is. */
export function blueprintOfVariant(variant: Variant): AnyBlueprint {
	return isRecordClass(variant) ? variant.blueprint : variant;
}

/**
 * The variant that the plain `value` names with the key of `field`, if it
 * names one: a blueprint or a record class.
 */
export function namedVariantOf(
	field: AnyBlueprintVariant,
	value: unknown,
): Variant | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const tag = (value as Record<string, unknown>)[field.key];
	const variants: BlueprintVariants = field.variants;
	return typeof tag === "string" && Object.hasOwn(variants, tag)
		? variants[tag]
		: undefined;
}

/** The blueprint of the variant that the plain `value` names with the key of `field`, if it names one. */
export function variantOfValue(
	field: AnyBlueprintVariant,
	value: unknown,
): AnyBlueprint | undefined {
	const variant = namedVariantOf(field, value);
	return variant && blueprintOfVariant(variant);
}

/**
 * The name of the variant `instance` is, a record of one of the classes of
 * `field`; `undefined` when it is of none.
 */
export function variantNameOf(
	field: AnyBlueprintVariant,
	instance: unknown,
): string | undefined {
	if (typeof instance !== "object" || instance === null) return undefined;
	const variants: BlueprintVariants = field.variants;
	for (const tag of Object.keys(variants)) {
		const variant = variants[tag];
		if (isRecordClass(variant) && instance instanceof variant) return tag;
	}
	return undefined;
}

/** Whether `value` is a field made by `variantOf`. */
export function isBlueprintVariant(
	value: unknown,
): value is AnyBlueprintVariant {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "variant"
	);
}
