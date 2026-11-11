# Prompts: baseline claude-code-2

**This baseline was written by the same Claude Code session (Claude Opus 5.5) that made [runs/claude-code-2](../../../runs/claude-code-2/prompts.md), not by `scripts/build-baseline.ts`.** No `ANTHROPIC_API_KEY` was available where the example was made.

The session wrote [app.ts](app.ts) from [BRIEF.md](../../../BRIEF.md) (version 2) and the instructions a scripted baseline gets (`BASELINE_INSTRUCTIONS` in [scripts/prompts.ts](../../../scripts/prompts.ts)), as plain Hono + Zod in a single file. It started from [the baseline of brief 1](../claude-code-1/app.ts) and added what brief 2 asks for: tokens signed and verified with `hono/jwt` (HS256, secret from `JWT_SECRET`, an issuer, 15 minutes), a `caller` function that every event route calls first, the organizer of a new event taken from the token, `PATCH /api/events/{id}`, and a 404 for an event of another organizer. It passed its first evaluation; it was then only formatted by Biome.

It is not a blind baseline, for the same reasons as claude-code-1: the session wrote the ownership checks before it, and the brief states the rule. Read its result as "a careful single file that knows the checks can pass them", not as what an agent does on average.

> Write the backend of the brief below as a single TypeScript file for Bun, with Hono and Zod (v4) and no other dependency. Keep the data in memory. The file must export the Hono app as its default export (export default app); do not call Bun.serve or listen on a port. Answer with the file only, in one ```ts code block.
