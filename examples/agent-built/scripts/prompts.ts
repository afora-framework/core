/**
 * The instructions each kind of run gets besides the brief. The scripted runs
 * write the exact prompt they sent into their run directory (`prompts.md`).
 *
 * Both sides get the same footing: a tool loop with the same model, effort
 * and turns, tools to build and check their work, and the same line about the
 * contract. For brief 3, whose point is that the guarantees are not listed,
 * neither side's instructions say which guarantees hold: they describe the
 * tools and how to work, nothing else.
 */
import type { BriefVersion } from "../eval/invariants.ts";
import type { Db } from "./storage.ts";

/** The line both sides get about the contract of the brief. */
export const CONTRACT_LINE =
	"- Follow the routes, bodies, response keys and statuses of the contract exactly.";

/** For an afora run of brief 1 or 2 in memory: only the MCP tools, no file access. Kept as the committed runs got it. */
export const AGENT_INSTRUCTIONS = `You build the backend of the brief below with afora, only through the afora MCP tools you are given (afora_catalog, afora_spec_read, afora_spec_upsert, afora_spec_remove, afora_spec_write, afora_spec_validate, afora_generate, afora_extract). You cannot read or write files: the spec (afora.json) and the generated code (src/domain) are the whole deliverable, and nothing else will be written by hand.

- Use the provider "inMemory" (set it with afora_spec_write; it is the only tool that sets "provider").
- Expose the HTTP contract of the brief as an output named "Api" whose pipe ends with the sink "hono" (listed in the stages of afora_catalog). Its options: "basePath" (a prefix of every route, e.g. "/api"); "route": { "<Command>.<operation>": { "method"?: "get" | "post" | "put" | "patch" | "delete", "path"?: "/things/{id}", "status"?: 200 | 201 | 202 | 204 } }, where a "{name}" segment of the path is a scalar key of the operation's input (taken from the path, not the body); "docs": { "path": "/openapi.json", "info": { "title", "version" } }; "auth": { "jwt": { "secret": { "env": "JWT_SECRET" }, "issuer"?: string } } reads a bearer token and gives the caller the "access" of each use case is checked against (401 Unauthenticated, 403 Forbidden). By default a route is POST {basePath}/{kebab(command)}/{kebab(operation)} with status 200. The sink validates the input, rejects undeclared keys, masks sensitive values and answers errors as application/problem+json: 400 for invalid input, 404 RepositoryEntityNotFound and UseCaseEntityNotFound, 409 RepositoryUniqueViolation and UseCaseEntityConflict, 401 UseCaseInvalidCredentials, 422 for the exceptions a use case declares in "errors", 500 otherwise; the output's "statuses" maps an exception name to another status.
- Follow the routes, bodies, response keys and statuses of the contract exactly.
- Finish with afora_generate and fix the spec until it reports no diagnostics. When you are done, say so in one sentence.`;

/**
 * What AGENT_INSTRUCTIONS says the sink guarantees, which a brief 3 run is
 * not told: it learns what the sink does from the guide, as a developer would.
 */
const SINK_GUARANTEES =
	'The sink validates the input, rejects undeclared keys, masks sensitive values and answers errors as application/problem+json: 400 for invalid input, 404 RepositoryEntityNotFound and UseCaseEntityNotFound, 409 RepositoryUniqueViolation and UseCaseEntityConflict, 401 UseCaseInvalidCredentials, 422 for the exceptions a use case declares in "errors", 500 otherwise; the output\'s "statuses" maps an exception name to another status.';
const SINK_NEUTRAL =
	'The output\'s "statuses" maps an exception name to an HTTP status; the guide describes what the sink does with the input and the errors.';

const MEMORY_PROVIDER =
	'- Use the provider "inMemory" (set it with afora_spec_write; it is the only tool that sets "provider").';
const SQLITE_PROVIDER =
	'- Use the provider "drizzle" of the catalog, over the database the project already has: set it with afora_spec_write as { "use": "drizzle", "options": { "db": { "import": "../db.ts#db" }, "tables": { "import": "../db.ts#tables" } } }. src/db.ts exists and is not yours to write: it opens the SQLite database of the brief and creates a table for each entity of the application when the app starts.';

/** The instructions of an afora run of `brief` on `db`. */
export function agentInstructions(
	db: Db = "memory",
	brief: BriefVersion = 2,
): string {
	for (const part of [SINK_GUARANTEES, MEMORY_PROVIDER, CONTRACT_LINE]) {
		if (!AGENT_INSTRUCTIONS.includes(part)) {
			throw new Error(`AGENT_INSTRUCTIONS lost: ${part.slice(0, 60)}`);
		}
	}
	let text = AGENT_INSTRUCTIONS;
	if (db === "sqlite") text = text.replace(MEMORY_PROVIDER, SQLITE_PROVIDER);
	if (brief === 3) text = text.replace(SINK_GUARANTEES, SINK_NEUTRAL);
	return text;
}

/** The tools of a baseline run, as its instructions name them. */
export const BASELINE_TOOLS = [
	"write_file",
	"read_file",
	"list_files",
	"check",
	"smoke",
] as const;

/** The instructions of a baseline run of `brief` on `db`: the same loop, plain Hono + Zod. */
export function baselineInstructions(
	db: Db = "memory",
	_brief: BriefVersion = 2,
): string {
	const storage =
		db === "memory"
			? "- Keep the data in memory."
			: '- Keep the data in SQLite with bun:sqlite (import { Database } from "bun:sqlite"; Drizzle ORM over it, drizzle-orm/bun-sqlite, is also available), in the file named by process.env.DATABASE_PATH (":memory:" when it is not set), and create the tables when the module loads.';
	const dependencies =
		db === "memory"
			? "Hono and Zod (v4) and no other dependency"
			: "Hono, Zod (v4), bun:sqlite and drizzle-orm, and no other dependency";
	return `You build the backend of the brief below as TypeScript for Bun, with ${dependencies}, only through the tools you are given (${BASELINE_TOOLS.join(", ")}). The project directory has a tsconfig.json and nothing else; the files you write there are the whole deliverable.

${storage}
- The entry is app.ts: it exports the Hono app as its default export (export default app) and does not call Bun.serve nor listen on a port. It may import other files you write.
- check type-checks the project (tsc --noEmit) and gives its diagnostics. smoke loads app.ts in a fresh process (with JWT_SECRET set${db === "sqlite" ? " and DATABASE_PATH a new SQLite file" : ""}) and sends the requests you give, in order, to its fetch handler, giving back the status, content type and body of each.
${CONTRACT_LINE}
- Finish with check and fix the code until it reports no diagnostics. When you are done, say so in one sentence.`;
}
