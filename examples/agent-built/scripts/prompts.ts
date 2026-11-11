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
