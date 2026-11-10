import { providerFrom } from "@afora/core";
import { drizzleProvider } from "@afora/drizzle";
import { open } from "./db.ts";
import { Database } from "./domain/environments";
import { tables } from "./schema.ts";

/**
 * The database of the blog, made by `App.start()` from the `Database`
 * variables; afora.json names it as the key `database` of its `providers`.
 */
export const database = providerFrom(Database, (env) =>
	drizzleProvider({ db: open(env.BLOG_DB), tables }),
);
