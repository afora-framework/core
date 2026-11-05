import { recordBuilderOf } from "../core/record/record";
import { StdRecordPlugins } from "./record-plugins";

/**
 * A record of `blueprint`, e.g. `class User extends recordOf(UserBlueprint) {}`,
 * whose `options.plugins` picks from the standard plugins, as
 * `(ctx) => [ctx.publishable]`, or takes any plugin made by `recordPluginOf`.
 */
export const recordOf = recordBuilderOf(StdRecordPlugins);
