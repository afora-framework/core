# A backend built by an agent, with an invariant evaluation

The claim this example tests: an agent that writes a backend with afora, through the [MCP server](../../packages/mcp/README.md) only, cannot break the guarantees afora gives, because it never writes the code that holds them. It writes a spec; the code that masks secrets, rejects unknown keys, maps errors to statuses and enforces unique keys is the framework's.

So the example has three parts: a product brief, an app built from it through MCP tool calls alone, and an evaluation that checks those guarantees on the running API of every run, and of a hand-rolled Hono + Zod baseline written from the same brief.

## Status of the results

**One run of each has been made so far, both by a Claude Code session, not by the scripted N-run evaluation.** There was no `ANTHROPIC_API_KEY` where the example was made, so:

- the afora run, [`runs/claude-code-1`](runs/claude-code-1/prompts.md), is a Claude Code session (Claude Opus 5.5) calling the MCP server one tool at a time, recorded in [`tool-calls.json`](runs/claude-code-1/tool-calls.json);
- the baseline, [`baseline/runs/claude-code-1`](baseline/runs/claude-code-1/prompts.md), was written by the same session.

The scripts that make N runs of each with the Claude API ([`build-with-agent.ts`](scripts/build-with-agent.ts), [`build-baseline.ts`](scripts/build-baseline.ts)) are committed and tested to refuse to run without a key, but **have not been run: the scripted N-run results are pending until `bun run eval:agent-built` is run with a key.** Nothing below comes from them.

## The brief

[BRIEF.md](BRIEF.md): organizers sign up and log in (unique email, a password that is never shown), create events (unique slug, a capacity) and sell tickets until the event is sold out. It fixes the HTTP contract, routes, bodies and statuses, so the same checks run against any implementation, and it states each guarantee as a product requirement, so the baseline is asked for them as plainly as afora gives them.

## The app

- [afora.json](afora.json) and [src/domain](src/domain) are the output of the 27 recorded tool calls (`afora_spec_write`, `afora_spec_upsert`, `afora_generate`...), never edited by hand. [scripts/replay.ts](scripts/replay.ts) replays the calls through the MCP server into an empty directory, and a test checks that it gives back both, byte for byte.
- The only hand-written files are [src/server.ts](src/server.ts) (`App.start()` and `Bun.serve`) and [catalogs.ts](catalogs.ts), which tells codegen where the `hono` sink comes from.
- Four use cases are standard ones (`register`, `login`, `create`, `get`). Selling a ticket is written as steps in the spec: load the event, store the ticket, ask the repository whether a ticket exists past the capacity and throw `SoldOut` (422) if one does; the command runs in a transaction, so the extra ticket is rolled back.

```bash
bun install
bun run start      # http://localhost:3000/api, OpenAPI at /openapi.json
bun run generate   # afora.json -> src/domain, as afora_generate does
bun test           # drift, round trip, replay, the API, the evaluation
```

## The evaluation

[eval/invariants.ts](eval/invariants.ts) plays a scenario through the contract on a fetch handler (no port is opened) and checks four invariants:

| Invariant                                                | What is checked                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No sensitive value in any response                       | In every response of the scenario, errors included: no password that was sent, no password hash (argon2, bcrypt, scrypt, PBKDF2), and no key named like a secret (`password`, `hash`, `secret`, `salt`) holding anything but `"********"`.                                                                                     |
| Undeclared keys rejected (4xx)                           | Each of the four POST routes, sent a valid body plus one key the contract does not have, answers a 4xx.                                                                                                                                                                                                                        |
| Errors are problem+json with the right status, never 5xx | Taken email and slug (409), wrong password and unknown email (401), unknown organizer and event (404), sold out (422), weak password, capacity 0, a body that is not JSON and a missing field (400): each an `application/problem+json` whose body carries the status and a title. No response of the whole scenario is a 5xx. |
| Unique keys enforced (409)                               | A second organizer with the same email and a second event with the same slug are refused with a 409 problem.                                                                                                                                                                                                                   |

[eval/run.ts](eval/run.ts) evaluates every run: each afora run under `runs/` is first replayed from its `tool-calls.json` into a fresh directory (so what is evaluated is what the calls produce), and each baseline under `baseline/runs/` is imported as it is. Each run is checked in its own process, and the results go to [eval/RESULTS.md](eval/RESULTS.md). The test suite runs the evaluation, fails if any afora run fails an invariant, and checks that the committed RESULTS.md is what the runs give; a baseline that fails is a result, not a test failure. A test also runs the checks against a deliberately careless API (hash in the response, unknown keys kept, duplicates allowed, errors thrown) to show that each invariant can fail.

## Results

From [eval/RESULTS.md](eval/RESULTS.md):

| Implementation | Run           | No sensitive value in any response | Undeclared keys rejected (4xx) | Errors are problem+json with the right status, never 5xx | Unique keys enforced (409) |
| -------------- | ------------- | ---------------------------------- | ------------------------------ | -------------------------------------------------------- | -------------------------- |
| afora          | claude-code-1 | pass (23/23)                       | pass (4/4)                     | pass (20/20)                                             | pass (2/2)                 |
| baseline       | claude-code-1 | pass (23/23)                       | pass (4/4)                     | pass (20/20)                                             | pass (2/2)                 |

Both pass every check. What this shows, and what it does not:

- **The afora run holds every invariant without writing any code for them.** The spec declares an `authenticatable` organizer, a `slug`, the exceptions and their statuses; masking, unknown-key rejection, problem+json and the 409 on unique keys come from `@afora/core` and `@afora/hono`. The baseline holds them too, because it wrote each one by hand: `.strict()` on every Zod schema, a function that drops the hash before each response, its own problem+json and `onError`, its own maps for unique emails and slugs, its own capacity counter.
- **One careful run each says nothing about how often an agent gets the baseline right.** The baseline was written by the session that had just written the checks, from a brief that names every guarantee, so it was never likely to miss one. The question the evaluation is built for, how many of N independent runs hold every invariant with and without afora, is what the scripted runs will answer.

## Limitations

- **One run each, by a Claude Code session.** Not N runs, and not the scripted loop: the session had the repository at hand (afora's docs and source) while it made the tool calls, which a scripted run does not, and it wrote the evaluation before the app and the baseline. The scripted runs remove both advantages.
- **The checks are the invariants afora claims, on this contract.** They do not check the rest of the product (that an organizer only sees their own events, for one), nor concurrency (two last tickets bought at once), nor anything the scenario does not exercise.
- **A brief that states the guarantees favors the baseline**, which is deliberate: it makes the comparison about whether they hold, not about whether the agent guessed them.
- **In memory only.** Both implementations keep their data in memory; a database changes how uniqueness and the sold-out rollback are enforced.

## Reproduce with a key

```bash
export ANTHROPIC_API_KEY=...
bun run eval:agent-built    # from the repository root: 5 afora runs, 5 baselines, then the evaluation
```

or step by step, in this directory:

```bash
bun run build:agent -- --runs 5      # runs/<timestamp>-<n>/: transcript.jsonl, tool-calls.json, prompts.md, afora.json, src/domain
bun run build:baseline -- --runs 5   # baseline/runs/<timestamp>-<n>/: prompts.md, answer.md, app.ts
bun run eval                         # writes eval/RESULTS.md
```

The model is `claude-opus-5-5` with adaptive thinking at effort `high`; `--model` / `AFORA_EVAL_MODEL` and `--effort` / `AFORA_EVAL_EFFORT` change them. An afora run gets the instructions of [scripts/prompts.ts](scripts/prompts.ts), the guide and the catalog of the MCP server as its system prompt, the brief as its message, and the MCP tools; a baseline gets the brief and is asked for one Hono + Zod file, with no tools. Each run writes the exact prompts it sent. Commit the runs and the new RESULTS.md together; `bun test` then checks that every afora run holds every invariant.
