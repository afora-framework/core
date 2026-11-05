import { blueprintBuilderOf } from "../core/blueprint/blueprint";
import { Std } from "./blueprint-plugin";

/**
 * Builds a blueprint from the standard properties, e.g.
 * `blueprintOf((ctx) => ({ name: ctx.string }))`, and from `sources`, plugins
 * or blueprints, given before the definition, which can replace any `Std` key.
 */
export const blueprintOf = blueprintBuilderOf(Std);
