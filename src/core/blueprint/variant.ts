import { parseField } from "../parse/parse";
import { withStandard } from "../standard/standard";
import { Kind } from "../symbols/kind";
import { InvalidBlueprintVariant } from "./exceptions";
import { isBlueprint } from "./is-blueprint";
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
 * with the name of the variant for its value.
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
	for (const tag of tags) {
		const variant = variants[tag];
		if (!isBlueprint(variant)) fail(`the variant "${tag}" is not a blueprint`);
		if (Object.hasOwn((variant as { properties: object }).properties, key)) {
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

/** The blueprint of the variant that `value` names with the key of `field`, if it names one. */
export function variantOfValue(
	field: AnyBlueprintVariant,
	value: unknown,
): AnyBlueprint | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const tag = (value as Record<string, unknown>)[field.key];
	const variants: BlueprintVariants = field.variants;
	return typeof tag === "string" && Object.hasOwn(variants, tag)
		? variants[tag]
		: undefined;
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
