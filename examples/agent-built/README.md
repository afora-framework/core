# A backend built by an agent, with an invariant evaluation

The claim this example tests: an agent that writes a backend with afora, through the [MCP server](../../packages/mcp/README.md) only, cannot break the guarantees afora gives, because it never writes the code that holds them. It writes a spec; the code that masks secrets, rejects unknown keys, maps errors to statuses and enforces unique keys is the framework's.

So the example has three parts: a product brief, an app built from it through MCP tool calls alone, and an evaluation that checks those guarantees on the running API of every run, and of a hand-rolled Hono + Zod baseline written from the same brief.

## Status of the results

**Two runs of each have been made so far, one per version of the brief, all by Claude Code sessions, not by the scripted N-run evaluation.** There was no `ANTHROPIC_API_KEY` where the example was made, so:

- the afora runs, [`runs/claude-code-1`](runs/claude-code-1/prompts.md) (brief 1) and [`runs/claude-code-2`](runs/claude-code-2/prompts.md) (brief 2), are Claude Code sessions (Claude Opus 5.5) calling the MCP server one tool at a time, recorded in their `tool-calls.json`;
- the baselines, [`baseline/runs/claude-code-1`](baseline/runs/claude-code-1/prompts.md) and [`baseline/runs/claude-code-2`](baseline/runs/claude-code-2/prompts.md), were written by the same sessions.

The scripts that make N runs of each with the Claude API ([`eval.ts`](scripts/eval.ts), which drives [`build-with-agent.ts`](scripts/build-with-agent.ts) and [`build-baseline.ts`](scripts/build-baseline.ts)) are committed and tested to refuse to run without a key, but **have not been run: the scripted N-run results are pending until `bun run eval:agent-built` is run with a key** (see [Running the evaluation](#running-the-evaluation)). Nothing below comes from them. [eval/RESULTS.md](eval/RESULTS.md) labels the four runs above as not scripted.

## The brief

[BRIEF.md](BRIEF.md): organizers sign up and log in for a token (unique email, a password that is never shown), create events (unique slug, a capacity) that only they can read or change, and sell tickets until the event is sold out. It fixes the HTTP contract, routes, bodies and statuses, so the same checks run against any implementation, and it states each guarantee as a product requirement, so the baseline is asked for them as plainly as afora gives them.

That is version 2. [Version 1](BRIEF.v1.md) had no tokens and no owners: anyone could create an event for any organizer and read any event. [Version 3](BRIEF.v3.md) is the product and the contract of version 2 (routes, bodies, statuses, problem+json) described without listing the guarantees: it does not say that the password never appears in a response, that unknown fields are rejected, that emails and slugs are unique beyond the 409 of the table, that only its organizer sees an event, or that an error is never a 5xx. A baseline built from it has to think of them; it is evaluated with the same invariants as version 2. Each run says in its `run.json` which version it was built from (and its model and database), and is evaluated against that version.

## The app

- [afora.json](afora.json) and [src/domain](src/domain) are the output of the 26 tool calls recorded in [runs/claude-code-2](runs/claude-code-2/prompts.md) (`afora_spec_write`, `afora_spec_upsert`, `afora_generate`...), never edited by hand. [scripts/replay.ts](scripts/replay.ts) replays the calls through the MCP server into an empty directory, and a test checks that it gives back both, byte for byte.
- The only hand-written files are [src/server.ts](src/server.ts) (`App.start()` and `Bun.serve`) and [catalogs.ts](catalogs.ts), which tells codegen where the `hono` sink comes from.
- Five use cases are standard ones (`register`, `login`, `create`, `get`, `update`). Ownership is declared on the three event operations: `access` fills the context key `organizerId` from the token (a 401 without one), and the `owner` option makes `create` store that organizer and `get` and `update` answer an event of another organizer as not found (404). `login` signs the token with `JWT_SECRET`, and the `hono` sink verifies it. Selling a ticket is written as steps in the spec: load the event, store the ticket, ask the repository whether a ticket exists past the capacity and throw `SoldOut` (422) if one does; the command runs in a transaction, so the extra ticket is rolled back.

```bash
bun install
JWT_SECRET=$(openssl rand -hex 32) bun run start   # http://localhost:3000/api, OpenAPI at /openapi.json
bun run generate   # afora.json -> src/domain, as afora_generate does
bun test           # drift, round trip, replay, the API, the evaluation
```

## The evaluation

[eval/invariants.ts](eval/invariants.ts) plays a scenario through the contract on a fetch handler (no port is opened) and checks six invariants; ownership only for runs of briefs 2 and 3, the others with the routes and bodies of the run's brief:

| Invariant                                                  | What is checked                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No sensitive value in any response                         | In every response of the scenario, errors included: no password that was sent, no password hash (argon2, bcrypt, scrypt, PBKDF2), and no key named like a secret (`password`, `hash`, `secret`, `salt`) holding anything but `"********"`.                                                                                                        |
| Undeclared keys rejected (4xx)                             | Each of the four POST routes, sent a valid body plus one key the contract does not have, answers a 4xx.                                                                                                                                                                                                                                           |
| Errors are problem+json with the right status, never 5xx   | Taken email and slug (409), wrong password and unknown email (401), unknown organizer and event (404), sold out (422), weak password, capacity 0, a body that is not JSON and a missing field (400): each an `application/problem+json` whose body carries the status and a title. No response of the whole scenario is a 5xx.                    |
| Unique keys enforced (409)                                 | A second organizer with the same email and a second event with the same slug are refused with a 409 problem.                                                                                                                                                                                                                                      |
| Only its organizer reads or changes an event (briefs 2, 3) | Without a token, creating, reading or changing an event is a 401 problem, as is a malformed token or one signed with another secret. A second organizer reading or changing the first one's event gets a 404 or 403 problem, and the event is unchanged after; an event belongs to the organizer of the token, and cannot be created for another. |
| Capacity holds when the last seats are bought at once      | An event of 3 seats with one sold, then four purchases sent at the same time for the 2 seats left: no more than 2 succeed, exactly 2 do (no seat is lost to a rollback), each other one is a 422 problem, and a purchase after them is a 422.                                                                                                     |

[eval/run.ts](eval/run.ts) evaluates every run: each afora run under `runs/` is first replayed from its `tool-calls.json` into a fresh directory (so what is evaluated is what the calls produce), and each baseline under `baseline/runs/` is imported as it is. A run on SQLite gets a fresh database file (`DATABASE_PATH`). Each run is checked in its own process, and the results go to [eval/RESULTS.md](eval/RESULTS.md): the pass rate of each invariant per model, brief, database and side, with its 95% Wilson interval, the scripted runs apart from the others, then every run and every failed check. A run that could not be evaluated (a baseline whose answer had no code, a replay or a start that failed) fails every invariant of its brief. The test suite runs the evaluation, fails if an afora run that was not scripted fails an invariant, and checks that the committed RESULTS.md is what the runs give; a scripted run or a baseline that fails is a result, not a test failure. A test also runs the checks against a deliberately careless API (hash in the response, unknown keys kept, duplicates allowed, errors thrown, no capacity) to show that each invariant can fail, on every brief, and against one that checks the capacity and sells after an `await`, to show that the concurrency check catches a race.

### On SQLite

With `--db sqlite`, both sides keep their data in SQLite, and the brief says so (its storage sentence is replaced; [scripts/storage.ts](scripts/storage.ts)). The baseline is asked to use `bun:sqlite` (or Drizzle over it) in the file named by `DATABASE_PATH`. The afora run's MCP server gets the `drizzle` provider of [`@afora/drizzle`](../../packages/drizzle/README.md) in its providers catalog (as `afora-mcp --providers @afora/drizzle` does), and the agent is told to name it in the spec over `src/db.ts`, which the harness writes into the run: it re-exports [db/sqlite.ts](db/sqlite.ts), the Drizzle database on the same file and a table per entity of the application, with a unique index on each key the spec declares unique, created before the app starts (what drizzle-kit would do from a schema). The agent cannot write files, so this is the one part it does not write: the baseline writes its own `CREATE TABLE`s and decides its own constraints, the afora run gets its tables (and the unique indexes of what it declared unique) from the harness. That is an asymmetry in afora's favor on SQLite; the drizzle provider also checks unique keys with a query before each write, so the 409s do not rest on the indexes alone. A test replays the calls of `runs/claude-code-2` with the provider changed to `drizzle` and checks that the app holds every invariant on a SQLite file, with the tickets in it.

## Results

From [eval/RESULTS.md](eval/RESULTS.md):

| Implementation | Run           | Brief | No sensitive value | Undeclared keys | Errors as problem+json | Unique keys | Ownership    | Concurrency |
| -------------- | ------------- | ----- | ------------------ | --------------- | ---------------------- | ----------- | ------------ | ----------- |
| afora          | claude-code-1 | 1     | pass (30/30)       | pass (4/4)      | pass (20/20)           | pass (2/2)  | not in brief | pass (5/5)  |
| afora          | claude-code-2 | 2     | pass (45/45)       | pass (5/5)      | pass (21/21)           | pass (2/2)  | pass (12/12) | pass (5/5)  |
| baseline       | claude-code-1 | 1     | pass (30/30)       | pass (4/4)      | pass (20/20)           | pass (2/2)  | not in brief | pass (5/5)  |
| baseline       | claude-code-2 | 2     | pass (45/45)       | pass (5/5)      | pass (21/21)           | pass (2/2)  | pass (12/12) | pass (5/5)  |

Both pass every check. What this shows, and what it does not:

- **The afora runs hold every invariant without writing any code for them.** The spec declares an `authenticatable` organizer, a `slug`, the exceptions and their statuses, and in brief 2 an `access` and an `owner` on each event operation; masking, unknown-key rejection, problem+json and the 409 on unique keys come from `@afora/core` and `@afora/hono`. The baseline holds them too, because it wrote each one by hand: `.strict()` on every Zod schema, a function that drops the hash before each response, its own problem+json and `onError`, its own maps for unique emails and slugs, its own capacity counter, and in brief 2 its own token signing and verification and an owner check in every event route.
- **One careful run each says nothing about how often an agent gets the baseline right.** The baseline was written by the session that had just written the checks, from a brief that names every guarantee, so it was never likely to miss one. The question the evaluation is built for, how many of N independent runs hold every invariant with and without afora, is what the scripted runs will answer.

## Limitations

- **One run each, by a Claude Code session.** Not N runs, and not the scripted loop: the session had the repository at hand (afora's docs and source) while it made the tool calls, which a scripted run does not, and it wrote the evaluation before the app and the baseline. The scripted runs remove both advantages.
- **The checks are the invariants afora claims, on this contract.** They do not check the rest of the product, nor anything the scenario does not exercise. Concurrency is one burst of four purchases on one event, sent together to the handler of one process: it catches a check and a write apart, not every race a server with several processes or connections can have. With a synchronous store (a JavaScript array, or `bun:sqlite`, whose calls do not yield), a check and a write with no `await` between them cannot interleave, so the check will likely pass on both sides and not tell them apart; it fails only an implementation that awaits between reading the count and writing the ticket (shown by a test), or one with no capacity check. Ownership is checked on the event routes of briefs 2 and 3: the tokens it accepts are the ones `POST /api/sessions` gives, plus a malformed and a forged one; expiry is not exercised.
- **A brief that states the guarantees favors the baseline**, which is deliberate: it makes the comparison about whether they hold, not about whether the agent guessed them. Brief 3 is the other case, where they are not stated.
- **What is not equal between the sides.** Both run the same loop ([scripts/loop.ts](scripts/loop.ts)) with the same model, effort and turns, the same contract line and comparable feedback (afora: `afora_spec_validate`, `afora_generate` with its type check; baseline: `check`, a `tsc --noEmit`, and `smoke`, requests to its app in a fresh process). The afora run's system prompt also holds the guide and the catalog of the MCP server: that is the product being evaluated, so it stays. The baseline gets no Hono or Zod documentation; it relies on what the model knows of them. On SQLite, the afora tables come from the harness (above).
- **The committed runs are in memory.** `--db sqlite` runs both sides on SQLite; no such run has been made by an agent yet. On SQLite the afora side's tables come from the harness ([db/sqlite.ts](db/sqlite.ts)), not from the agent.

## Running the evaluation

With a key, from the repository root, this makes 20 runs per side, per model and per brief, on SQLite and in memory, then evaluates every run into `eval/RESULTS.md`:

```bash
export ANTHROPIC_API_KEY=...
bun run eval:agent-built -- --runs 20 --models claude-opus-5-5,claude-sonnet-5-5 --briefs 2,3 --db memory,sqlite
```

Add `--dry-run` to print the plan first: the number of runs and API requests and a rough token estimate measured from the prompts on this checkout, with no key needed and nothing called or written. Without a key and without `--dry-run`, the script exits 1 before any run.

```bash
bun run eval:agent-built -- --runs 20 --models claude-opus-5-5,claude-sonnet-5-5 --briefs 2,3 --dry-run
```

The flags of [scripts/eval.ts](scripts/eval.ts) (`bun run eval:all -- ...` in this directory):

| Flag          | Default                                    | What it sets                                              |
| ------------- | ------------------------------------------ | --------------------------------------------------------- |
| `--runs`      | `20`                                       | runs per side, model, brief and database                  |
| `--models`    | `AFORA_EVAL_MODEL`, else `claude-opus-5-5` | comma-separated model ids                                 |
| `--briefs`    | `2`                                        | comma-separated versions of the brief: `1`, `2`, `3`      |
| `--db`        | `memory`                                   | `memory`, `sqlite`, or both                               |
| `--sides`     | `afora,baseline`                           | which sides to run                                        |
| `--effort`    | `AFORA_EVAL_EFFORT`, else `high`           | the effort of adaptive thinking                           |
| `--max-turns` | `60`                                       | the turns an afora run may take                           |
| `--parallel`  | `4`                                        | runs made at the same time                                |
| `--dry-run`   |                                            | print the plan and the estimate, call nothing             |
| `--no-eval`   |                                            | make the runs, do not evaluate them (then `bun run eval`) |

Each run gets its own directory, `runs/<stamp>-<model>-b<brief>-<db>-<n>` (afora) or `baseline/runs/...`, whose `run.json` records the brief, the database, the model, the effort, how the run stopped and `"scripted": true`. A run that hits an API error (the API answered with one, or could not be reached) is started again from scratch, up to three times, then left out and listed at the end. Any other failure keeps the run, with the error in its `run.json`, and it fails every invariant; so does a run that ends without a working app (cut off, no app.ts, a spec that does not generate), and one whose evaluation takes more than 120 seconds (`AFORA_EVAL_TIMEOUT_MS`).

One run at a time, in this directory:

```bash
bun run build:agent -- --runs 5 --brief 3 --db sqlite      # runs/<timestamp>-<n>/: transcript.jsonl, tool-calls.json, prompts.md, run.json, afora.json, src/
bun run build:baseline -- --runs 5 --brief 3 --db sqlite   # baseline/runs/<timestamp>-<n>/: transcript.jsonl, tool-calls.json, prompts.md, run.json, app.ts
bun run eval                                               # writes eval/RESULTS.md
```

Both sides run the same tool loop ([scripts/loop.ts](scripts/loop.ts)), with the same model, effort, turns and stop rules, and the brief as the first message. An afora run gets the instructions of [scripts/prompts.ts](scripts/prompts.ts), the guide and the catalog of the MCP server as its system prompt, and the MCP tools. A baseline gets its own instructions there and the tools of [scripts/workspace.ts](scripts/workspace.ts): `write_file`, `read_file` and `list_files` in its project directory, `check` (`tsc --noEmit`, as `afora_generate` runs it) and `smoke` (app.ts loaded in a fresh process, the requests it gives sent to its fetch handler); it delivers `app.ts` and the files it imports. Both get the same line about following the contract exactly. For brief 3, neither side's instructions say which guarantees hold: the afora instructions lose the sentence on what the sink validates, rejects, masks and answers, and the SQLite instructions say nothing of unique indexes or transactions. Each run writes the exact prompts it sent. Commit the runs and the new RESULTS.md together; `bun test` then checks that RESULTS.md is what the runs give.
