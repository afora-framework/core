import { recordBuilderOf } from "../core/record/record";
import { StdRecordPlugins } from "./record-plugins";

/**
 * A record of `blueprint`, e.g. `class User extends recordOf(UserBlueprint) {}`,
 * whose `options.plugins` picks from the standard plugins, as
 * `(ctx) => [ctx.publishable]`, or takes any plugin made by {@link recordPluginOf}.
 *
 * @throws {@link ReservedRecordKey} when a key of the blueprint is a member of the record.
 * @throws {@link UndeclaredRecordProperty} when `sensitive`, `unique` or `change` names a key the blueprint does not declare.
 * @throws {@link InvalidRecordDeclaration} when `name` is not an identifier.
 *
 * @example
 * ```ts
 * import { blueprintOf, recordOf } from "@afora/core";
 *
 * class Account extends recordOf(
 * 	blueprintOf((ctx) => ({ email: ctx.email, token: ctx.string })),
 * 	{ sensitive: ["token"], change: ["email"] },
 * ) {}
 *
 * const account = new Account({ email: "Ana@Example.com", token: "secret" });
 * account.email; // "ana@example.com"
 * account.change.email("ann@example.com"); // same as set("email", ...)
 * JSON.stringify(account); // the token is masked
 * ```
 */
export const recordOf = recordBuilderOf(StdRecordPlugins);
