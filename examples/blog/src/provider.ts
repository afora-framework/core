import { drizzleProvider } from "@afora/drizzle";
import { db } from "./db.ts";
import { tables } from "./schema.ts";

/**
 * One provider instance shared by every repository: a command with
 * `transaction: true` checks at declaration that its repositories share one.
 */
export const provider = drizzleProvider({ db, tables });
