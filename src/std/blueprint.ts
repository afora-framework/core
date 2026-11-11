import { blueprintBuilderOf } from "../core/blueprint/blueprint";
import { Std } from "./blueprint-plugin";

/**
 * Builds a blueprint from the standard properties, e.g.
 * `blueprintOf((ctx) => ({ name: ctx.string }))`, and from `sources`, plugins
 * or blueprints, given before the definition, which can replace any `Std` key.
 *
 * @throws {@link ReservedBlueprintKey} when a source declares a key the context reserves (`optional`, `list`, `listOf`, `optionalOf`, `propertyOf`, `variantOf`).
 *
 * @example
 * ```ts
 * import { blueprintOf } from "@afora/core";
 *
 * const Signup = blueprintOf((ctx) => ({
 * 	name: ctx.text,
 * 	email: ctx.email, // trimmed and lowercased
 * 	tags: ctx.listOf(ctx.string, { maxItems: 5 }),
 * 	nickname: ctx.optional.string,
 * }));
 *
 * const parsed = Signup.safeParse({
 * 	name: "Ana",
 * 	email: " ANA@example.com ",
 * 	tags: [],
 * });
 * if (!parsed.issues) parsed.value.email; // "ana@example.com"
 * ```
 */
export const blueprintOf = blueprintBuilderOf(Std);
