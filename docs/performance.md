# Performance

How fast afora validates, how that is measured, and what CI does to keep it from getting slower. The numbers below are from the committed run (afora 0.0.9, Bun 1.4.4, Node 22 and 24, on one AMD EPYC machine). They change with the machine, so read the ratios, and read [bench/RESULTS.md](../bench/RESULTS.md) for the full tables. Performance numbers are not part of the [contract](../VERSIONING.md).

## What is measured

`bun run bench` times afora next to TypeBox (compiled), Ajv, Typia, Zod 4, Valibot, ArkType, Effect Schema, Yup and Joi, on seven scenarios, each with a valid and an invalid input (fourteen cases):

| Scenario       | Shape                                                             |
| -------------- | ----------------------------------------------------------------- |
| `flat`         | A small object with three fields, trimmed and lowercased.         |
| `nested`       | The flat user plus an address, a list of tags and ten addresses.  |
| `api-payload`  | The body of a request: an order with five items, an enum, a uuid. |
| `large-list`   | One object that holds 1,000 small items.                          |
| `union`        | Twelve events, each one of four variants told apart by `type`.    |
| `deep`         | Six objects, one inside the other.                                |
| `no-transform` | The flat object with nothing to transform.                        |

Every library declares the same rules, rejects undeclared keys and collects every error instead of stopping at the first, which is what afora always does. A contender that accepts the invalid input, rejects the valid one or lets an undeclared key through stops the run, so no row is fast for skipping a rule. Each row is timed in a process of its own, after a warm-up, in three rounds, and the best round counts. The method, the fairness rules and how to contest a row are in [bench/README.md](../bench/README.md).

It also measures bundle size (minified and gzipped, each library validating the flat object) and cold start (the time a new process takes to import that bundle, median of 15 processes).

## What the numbers say

afora does more per value than a checker: it normalizes, collects every issue, and returns frozen values. TypeBox, Ajv and Typia only check, so they are faster on valid input and are marked "no transforms" in the tables.

`blueprint.safeParse`, on Node 24, with the time of Zod 4 as a multiple of afora's (above 1.00x, Zod is slower):

| Case                       |    afora | Zod 4 |
| -------------------------- | -------: | ----: |
| Small flat object, valid   | 579.5 ns | 1.31x |
| Small flat object, invalid |  1017 ns | 2.53x |
| API request body, valid    |  5174 ns | 1.09x |
| API request body, invalid  |  6434 ns | 1.75x |
| List of 1,000 items, valid | 339.2 µs | 0.62x |
| Union of 4 variants, valid |  1068 ns | 4.52x |
| 6 levels of nesting, valid |  1609 ns | 0.80x |

Read it as: on the common shapes afora is ahead of Zod 4, and it is behind on a long list of small items and on a deep object that is valid. The table of [the README](../README.md#performance) has all fourteen cases and the other libraries. Three things to know:

- **Invalid input is not a slow path.** Collecting issues is held to the same budget as the valid case, and the guard below covers both.
- **Creating a record or entity costs more than parsing.** `Record.safeParse` also builds the instance, and an entity also makes its `id` and `createdAt`. On the flat object on Bun, `blueprint.safeParse` takes about 400 ns, `Record.safeParse` about 570 ns and `Entity.safeParse` about 1.7 µs. Parse with the blueprint when you need only to check.
- **afora is larger and slower to start than a validator.** Its bundle carries TypeBox and the code of records, entities, repositories and use cases, whatever the file uses: 408.5 kB minified and 107.1 kB gzipped for the flat object, against 85.0 kB and 24.3 kB for Zod. Cold start is about 72 to 78 ms against about 12 ms for Zod. That matters for a function that starts on every request, and not for a server that starts once.

## Running it

```bash
bun run bench                      # everything, on Bun and Node; about half an hour
bun run bench -- --only flat,union # some scenarios; prints and writes nothing
bun run bench -- --only flat --rounds 1   # a quick look
bun run bench:guard                # afora against Zod 4, fails over a limit (what CI runs)
bun run bench:check                # README block, RESULTS.md and the chart match latest.json
```

`bun run bench` rewrites `bench/results/latest.json` and `bench/RESULTS.md`, and the table and chart of the README are generated from the same file (`bun run bench -- --render` regenerates them without measuring; `bench:check` fails when they are edited by hand). Run it on an idle machine. Node is the `node` on the `PATH`, or each binary in `BENCH_NODE_BINS` (paths separated by `:`):

```bash
BENCH_NODE_BINS="$(mise where node@22)/bin/node:$(mise where node@24)/bin/node" bun run bench -- --only flat
```

## What CI holds

**The guard.** `bun run bench:guard` times `blueprint.safeParse` and Zod 4 `safeParse` on each of the fourteen cases, taking turns in one process, and fails when afora is over the limit of a case, as a multiple of Zod 4. It compares a ratio measured in one process, so it does not depend on the machine, and it takes about 75 seconds. The limit is in `bench/guard.limits.ts`:

| Case               | Limit | Why                                                                                                 |
| ------------------ | ----: | --------------------------------------------------------------------------------------------------- |
| every other case   | 1.15x | afora is at or below Zod 4 there, and 15% is the noise of a shared runner.                          |
| `large-list valid` | 1.25x | afora is level with Zod 4 (about 1.0x): freezing 1,000 objects and their array is most of the time. |

A limit is where afora is plus room for noise, never room for a regression. It is raised only for a cost that is wanted, with the reason written next to it, and the pull request says why. When the guard fails, run it again to rule out noise, then find what the change costs. Run it when you touch `src/core/parse`, `src/core/property`, `src/core/schema` or the constructor of a record.

**Against the base.** A pull request is also timed against its base (`.github/workflows/bench-compare.yml`): `blueprint.safeParse`, `Record.safeParse` and `Entity.safeParse` of both checkouts on every case, and a `blueprint.safeParse` row over 1.1x its base fails. Locally: `bun run bench -- --compare <checkout of the base>`.

**Editor cost.** `bun run test:type-perf` budgets the type instantiations per edit, which is the speed of the editor rather than of the runtime. See [CONTRIBUTING.md](../CONTRIBUTING.md#checks).

## Adding a scenario or a library

Follow [bench/README.md](../bench/README.md): one file per shape in `bench/scenarios/`, the schema of every library side by side, and an adapter in `bench/contenders.ts`. The Typia validators are generated with `bun run typia` in `bench/`, which needs Go.
