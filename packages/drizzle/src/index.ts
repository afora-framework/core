export type {
	DrizzleDatabase,
	DrizzleProvider,
	DrizzleProviderOptions,
	DrizzleTable,
} from "./provider";
export { drizzleProvider } from "./provider";

/** The provider catalog entries for `afora-codegen --providers`. */
export const providers = [
	{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" },
] as const;
