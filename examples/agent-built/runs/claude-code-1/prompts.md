# Prompts: claude-code-1

**This run was performed by a Claude Code session (Claude Opus 5.5), not by the scripted API loop of `scripts/build-with-agent.ts`.** No `ANTHROPIC_API_KEY` was available where the example was made, so the session acted as the agent itself: it called the afora MCP server in process, one tool call at a time, through `scripts/call.ts`, which appended each call (and each resource read) to [tool-calls.json](tool-calls.json). It never edited `afora.json` or `src/domain` by hand. `scripts/replay.ts` replays that file into an empty directory and gives back the committed `afora.json` and `src/domain` byte for byte (a test checks it).

What differs from a scripted run:

- The session worked from a longer task description than the prompt below, and could read the repository (the docs of `@afora/core`, `@afora/codegen`, `@afora/hono` and `@afora/mcp`, and their source) while making the calls. A scripted run sees only the system prompt below with the guide and the catalog of the server, and the tools.
- The session wrote [the evaluation](../../eval/invariants.ts) before making the calls, so it knew which checks the API would face.
- There is no `transcript.jsonl`: the conversation was not an API loop. The tool calls are the whole record of what was done to the project.

## Brief

[BRIEF.v1.md](../../BRIEF.v1.md), version 1 of the brief (see `run.json`).

## Instructions

The same instructions a scripted run gets (`AGENT_INSTRUCTIONS` in [scripts/prompts.ts](../../scripts/prompts.ts)):

> You build the backend of the brief below with afora, only through the afora MCP tools you are given (afora_catalog, afora_spec_read, afora_spec_upsert, afora_spec_remove, afora_spec_write, afora_spec_validate, afora_generate, afora_extract). You cannot read or write files: the spec (afora.json) and the generated code (src/domain) are the whole deliverable, and nothing else will be written by hand.
>
> - Use the provider "inMemory" (set it with afora_spec_write; it is the only tool that sets "provider").
> - Expose the HTTP contract of the brief as an output named "Api" whose pipe ends with the sink "hono" (listed in the stages of afora_catalog). Its options: "basePath" (a prefix of every route, e.g. "/api"); "route": { "<Command>.<operation>": { "method"?: "get" | "post" | "put" | "patch" | "delete", "path"?: "/things/{id}", "status"?: 200 | 201 | 202 | 204 } }, where a "{name}" segment of the path is a scalar key of the operation's input (taken from the path, not the body); "docs": { "path": "/openapi.json", "info": { "title", "version" } }. By default a route is POST {basePath}/{kebab(command)}/{kebab(operation)} with status 200. The sink validates the input, rejects undeclared keys, masks sensitive values and answers errors as application/problem+json: 400 for invalid input, 404 RepositoryEntityNotFound and UseCaseEntityNotFound, 409 RepositoryUniqueViolation and UseCaseEntityConflict, 401 UseCaseInvalidCredentials, 422 for the exceptions a use case declares in "errors", 500 otherwise; the output's "statuses" maps an exception name to another status.
> - Follow the routes, bodies, response keys and statuses of the contract exactly.
> - Finish with afora_generate and fix the spec until it reports no diagnostics. When you are done, say so in one sentence.

## What the calls did

27 steps: read the guide, the catalog, `afora_spec_write` for the header (`provider: "inMemory"`), then one `afora_spec_upsert` per declaration (a `Capacity` property; the `Organizer`, `Event` and `Ticket` entities; three repositories; five exceptions; five use cases; two commands; the `Api` output), `afora_spec_validate` and `afora_generate`, which type-checked the generated files with no diagnostics. One correction is in the log: a command first named `Box` was removed and declared again as `BoxOffice`. No call failed.

Four use cases are standard ones (`register`, `login`, `create`, `get`). `BuyTicket` is written as steps: it loads the event, stores the ticket, then asks the repository whether a ticket exists past the capacity (`exists` with `offset: capacity`) and throws `SoldOut` if one does. The command runs in a transaction, so the extra ticket is rolled back. No hand-written function was needed.
