/**
 * The instructions each kind of run gets besides BRIEF.md. The scripted runs
 * write the exact prompt they sent into their run directory (`prompts.md`).
 */

/** For an afora run: only the MCP tools, no file access. */
export const AGENT_INSTRUCTIONS = `You build the backend of the brief below with afora, only through the afora MCP tools you are given (afora_catalog, afora_spec_read, afora_spec_upsert, afora_spec_remove, afora_spec_write, afora_spec_validate, afora_generate, afora_extract). You cannot read or write files: the spec (afora.json) and the generated code (src/domain) are the whole deliverable, and nothing else will be written by hand.

- Use the provider "inMemory" (set it with afora_spec_write; it is the only tool that sets "provider").
- Expose the HTTP contract of the brief as an output named "Api" whose pipe ends with the sink "hono" (listed in the stages of afora_catalog). Its options: "basePath" (a prefix of every route, e.g. "/api"); "route": { "<Command>.<operation>": { "method"?: "get" | "post" | "put" | "patch" | "delete", "path"?: "/things/{id}", "status"?: 200 | 201 | 202 | 204 } }, where a "{name}" segment of the path is a scalar key of the operation's input (taken from the path, not the body); "docs": { "path": "/openapi.json", "info": { "title", "version" } }; "auth": { "jwt": { "secret": { "env": "JWT_SECRET" }, "issuer"?: string } } reads a bearer token and gives the caller the "access" of each use case is checked against (401 Unauthenticated, 403 Forbidden). By default a route is POST {basePath}/{kebab(command)}/{kebab(operation)} with status 200. The sink validates the input, rejects undeclared keys, masks sensitive values and answers errors as application/problem+json: 400 for invalid input, 404 RepositoryEntityNotFound and UseCaseEntityNotFound, 409 RepositoryUniqueViolation and UseCaseEntityConflict, 401 UseCaseInvalidCredentials, 422 for the exceptions a use case declares in "errors", 500 otherwise; the output's "statuses" maps an exception name to another status.
- Follow the routes, bodies, response keys and statuses of the contract exactly.
- Finish with afora_generate and fix the spec until it reports no diagnostics. When you are done, say so in one sentence.`;

/** For a baseline run: plain Hono + Zod, one file. */
export const BASELINE_INSTRUCTIONS = `Write the backend of the brief below as a single TypeScript file for Bun, with Hono and Zod (v4) and no other dependency. Keep the data in memory. The file must export the Hono app as its default export (export default app); do not call Bun.serve or listen on a port. Answer with the file only, in one \`\`\`ts code block.`;

/**
 * For an afora run on SQLite: the provider line of AGENT_INSTRUCTIONS
 * replaced by the drizzle provider of the catalog, over the `src/db.ts` the
 * harness wrote (a Drizzle database on bun:sqlite, a table per entity).
 */
export const AGENT_SQLITE_PROVIDER = `- Use the provider "drizzle" of the catalog, over the database the project already has: set it with afora_spec_write as { "use": "drizzle", "options": { "db": { "import": "../db.ts#db" }, "tables": { "import": "../db.ts#tables" } } }. src/db.ts exists and is not yours to write: it opens the SQLite database of the brief and creates a table for each entity of the application, with a unique index on each unique key, when the app starts. The provider runs transactions.`;

/** For a baseline run on SQLite: the storage line of BASELINE_INSTRUCTIONS replaced. */
export const BASELINE_SQLITE_STORAGE = `Keep the data in SQLite with bun:sqlite (import { Database } from "bun:sqlite"; Drizzle ORM over it, drizzle-orm/bun-sqlite, is also available), in the file named by process.env.DATABASE_PATH (":memory:" when it is not set), and create the tables when the module loads.`;

/** The instructions of an afora run on `db`. */
export function agentInstructions(db: "memory" | "sqlite"): string {
	if (db === "memory") return AGENT_INSTRUCTIONS;
	const line = AGENT_INSTRUCTIONS.split("\n").find((l) =>
		l.startsWith('- Use the provider "inMemory"'),
	);
	if (!line) throw new Error("AGENT_INSTRUCTIONS has no provider line.");
	return AGENT_INSTRUCTIONS.replace(line, AGENT_SQLITE_PROVIDER);
}

/** The instructions of a baseline run on `db`. */
export function baselineInstructions(db: "memory" | "sqlite"): string {
	if (db === "memory") return BASELINE_INSTRUCTIONS;
	return BASELINE_INSTRUCTIONS.replace(
		"Keep the data in memory.",
		BASELINE_SQLITE_STORAGE,
	).replace("Hono and Zod (v4) and no other dependency", "Hono and Zod (v4)");
}
