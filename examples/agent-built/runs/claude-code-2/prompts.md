# Prompts: claude-code-2

**This run was performed by a Claude Code session (Claude Opus 5.5), not by the scripted API loop of `scripts/build-with-agent.ts`.** As for [claude-code-1](../claude-code-1/prompts.md), there was no `ANTHROPIC_API_KEY` where it was made, so the session acted as the agent itself: it called the afora MCP server in process, one tool call at a time, through `scripts/call.ts`, which appended each call (and each resource read) to [tool-calls.json](tool-calls.json). It started from an empty directory and never edited `afora.json` or `src/domain` by hand. `scripts/replay.ts` replays that file into an empty directory and gives back the committed `afora.json` and `src/domain` byte for byte (a test checks it).

What differs from a scripted run, beyond what claude-code-1 already lists (the session could read the repository, and wrote the evaluation before making the calls):

- Before recording, the same session tried the spec by hand in a scratch directory, generated it and ran the ownership checks against it. That is how it learned that `update` needs the entity's `change` keys (`UseCaseUnavailable` when the module loads otherwise). The recorded calls are the second, clean pass.
- It knew claude-code-1: the declarations that brief 2 does not change (the property, the exceptions, `BuyTicket`) are the same as there.

## Brief

[BRIEF.md](../../BRIEF.md), version 2 (see `run.json`): sessions with a token, events only their organizer reads or changes.

## Instructions

`AGENT_INSTRUCTIONS` in [scripts/prompts.ts](../../scripts/prompts.ts), the same a scripted run gets.

## What the calls did

26 steps, none failed: read the guide and the catalog, `afora_spec_write` for the header, one `afora_spec_upsert` per declaration, `afora_spec_validate` and `afora_generate`, which type-checked the generated files with no diagnostics. What brief 2 adds to claude-code-1 is all declaration, no code:

- `LoginOrganizer` (`login`) issues a token: `"token": { "secret": { "env": "JWT_SECRET" }, "issuer": "ticketing" }`; the `hono` sink verifies it with the same `"auth": { "jwt": … }`.
- `CreateEvent`, `GetEvent` and the new `UpdateEvent` (`create`, `get`, `update`) take `"access": { "context": { "organizerId": "subject" } }`, so a caller without a token gets a 401 and the context key is the signed-in organizer, and `"owner": { "key": "organizer", "context": "organizerId" }`, so `create` stores that organizer and `get` and `update` answer an event of another organizer as not found (404).
- `Event` declares `"change": ["title", "capacity"]`, what `PATCH /api/events/{id}` may change; the `Events` repository gains `update`.
- `RegisterOrganizer`, `LoginOrganizer` and `BuyTicket` say `"access": { "public": true }` on purpose.
