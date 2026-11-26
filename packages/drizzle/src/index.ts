import { InvalidRepositoryDeclaration } from "@afora/core";
import type { DrizzleDialect } from "./table";

export type {
	DrizzleDatabase,
	DrizzleProvider,
	DrizzleProviderOptions,
	DrizzleTable,
} from "./provider";
export { drizzleProvider } from "./provider";
export type {
	DrizzleColumnOverride,
	DrizzleDialect,
	DrizzleTableIndex,
	DrizzleTableOf,
	DrizzleTableOptions,
} from "./table";
export { drizzleTableOf } from "./table";

/** The provider catalog entries for `afora-codegen --providers`. */
export const providers = [
	{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" },
] as const;

/**
 * The provider catalog entries for `afora-codegen --providers` with the
 * tables generated from the spec, by `drizzleTableOf`: for one dialect
 * `schema.ts`, given to the provider as its `tables`; for both,
 * `schema.sqlite.ts` and `schema.pg.ts`, and the provider takes the
 * `tables` of your choice.
 */
export function drizzleCatalogOf(options: {
	readonly dialect: DrizzleDialect | readonly DrizzleDialect[];
}) {
	const dialects =
		typeof options?.dialect === "string" ? [options.dialect] : options?.dialect;
	if (
		!Array.isArray(dialects) ||
		dialects.length === 0 ||
		dialects.some((dialect) => dialect !== "sqlite" && dialect !== "postgres")
	) {
		throw new InvalidRepositoryDeclaration({
			source: "drizzleCatalogOf",
			details: {
				reason:
					'Expected dialect to be "sqlite", "postgres" or both, in a list.',
			},
		});
	}
	return [
		{
			...providers[0],
			tables: { export: "drizzleTableOf", dialect: options.dialect },
		},
	] as const;
}
