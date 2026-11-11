# Prompts: baseline claude-code-1

**This baseline was written by the same Claude Code session (Claude Opus 5.5) that made [runs/claude-code-1](../../../runs/claude-code-1/prompts.md), not by `scripts/build-baseline.ts`.** No `ANTHROPIC_API_KEY` was available where the example was made.

The session wrote [app.ts](app.ts) in one pass from [BRIEF.v1.md](../../../BRIEF.v1.md) (version 1 of the brief) and the instructions a scripted baseline gets (`BASELINE_INSTRUCTIONS` in [scripts/prompts.ts](../../../scripts/prompts.ts)), as plain Hono + Zod in a single file, with its usual care and nothing beyond what the brief asks. After its first evaluation it was only formatted by Biome; its code was not changed.

It is not a blind baseline: the same session had written [the evaluation](../../../eval/invariants.ts) before writing it, so it knew which checks the API would face, and the brief states each invariant as a requirement. Read its result as "a careful single file that knows the checks can pass them", not as what an agent does on average.

> Write the backend of the brief below as a single TypeScript file for Bun, with Hono and Zod (v4) and no other dependency. Keep the data in memory. The file must export the Hono app as its default export (export default app); do not call Bun.serve or listen on a port. Answer with the file only, in one ```ts code block.
