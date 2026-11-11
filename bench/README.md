# Benchmark

How fast afora validates, next to the validators people use: TypeBox (compiled), Ajv, Typia, Zod 4, Valibot, ArkType, Effect Schema, Yup and Joi. The numbers are in [RESULTS.md](RESULTS.md), generated from `results/latest.json`.

```bash
bun run bench                      # everything, on Bun and Node (about half an hour); writes results/latest.json and RESULTS.md
bun run bench -- --only flat,union # only some scenarios; prints, writes nothing (add --rounds 1 for a quick look)
bun run bench:guard                # afora against Zod 4, fails over a limit (what CI runs)
```

## What is measured

- **Time per call** on an already-built schema, with the sampler of [mitata](https://github.com/evanwashere/mitata), for a valid and an invalid input of each scenario. The tables give the mean, p75, p99 and the margin (half of the 95% confidence interval of the mean); two rows whose intervals overlap are reported as tied, not ranked. Three things keep a row from depending on anything but itself:
  - **A process per row.** Each row is timed by a process that times nothing else. Code that ran before changes what the engine makes of the code that runs after: in one process, compiled TypeBox was 13x slower on one case when six other scenarios had run first.
  - **A warm-up.** The row runs for 400 ms before it is sampled. With mitata's own warm-up alone, Node was at times still running unoptimized code and stayed twice as slow for the whole measurement, in about half of the processes.
  - **Rounds.** Every row is timed three times, taking turns with all the others, and its best round counts. A machine drifts over the half hour a run takes (heat, power, other programs); taking turns spreads that over every row.

  Measured this way on a laptop in use, two runs agree within 5% on 56 of 60 rows and within 8% on all of them. `--jobs` runs rows side by side to iterate faster, and its times are off by 1.4x and more, so it never writes results.
- **Bundle size**: each file of `entries/` validates the flat object with one library and is bundled by itself (`bun build --minify`), minified and gzipped.
- **Cold start**: the time a new process takes to import that bundle, which loads the library, builds the schema and validates once; the median of 15 processes.

Everything runs on Bun (afora from `src/`) and on Node (afora from a build), on the versions the report states. Node is the `node` on the PATH, or each binary listed in `BENCH_NODE_BINS` (paths separated by `:`, or `;` on Windows), one run per binary: the published results have Node 22 and Node 24. Each run is told apart by its version, in `RESULTS.md` and in the cold start columns; the block of the root README leads with the newest Node.

```bash
BENCH_NODE_BINS="$(mise where node@22)/bin/node:$(mise where node@24)/bin/node" bun run bench -- --only flat
```

## Scenarios

One file per shape in `scenarios/`, with the schema of every library side by side.

| id             | What it is                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `flat`         | A small object with three fields, trimmed and lowercased.                                                                   |
| `nested`       | The flat user plus an address, a list of tags and a list of ten addresses.                                                  |
| `api-payload`  | The body of a request: an order with a customer, a shipping address, five items, an enum, optional keys, a uuid and a date. |
| `large-list`   | One object that holds 1,000 small items.                                                                                    |
| `union`        | Twelve events, each one of four variants told apart by `type`.                                                              |
| `deep`         | Six objects, one inside the other.                                                                                          |
| `no-transform` | The flat object with nothing to transform, where a compiled checker is at its best.                                         |

## What makes the comparison fair

- **The same rules everywhere.** Every library declares the same constraints, rejects undeclared keys (`additionalProperties: false`, `strictObject`, `"+": "reject"`, `onExcessProperty: "error"`, `.exact()`, Joi's default) and collects every error instead of stopping at the first (`allErrors`, `abortEarly: false`, `errors: "all"`), because that is what afora always does.
- **Checked before it is timed.** A contender that accepts the invalid input, rejects the valid one or lets an undeclared key through stops the run (`verify` in `harness.ts`), so no row is fast for skipping a rule.
- **The same call everywhere.** A library is called through one adapter in `contenders.ts`, with the options fixed outside the timed function.
- **Versions are stated.** The report lists the installed version of every library.

What is not the same, and cannot be:

- **TypeBox, Ajv and Typia do not transform.** They only check, so where the others trim and lowercase, these get the already-clean value and are marked "no transforms". They are the floor: afora runs on TypeBox. `no-transform` and `union` are where they compete on equal terms. Typia's validator is generated at build time by `ttsc` (`bun run typia`; the output in `typia/generated` is committed).
- **Formats are each library's own.** What an email, a uuid or a date-time is differs a little from one to another. Effect Schema has no email or date-time check for strings, so a pattern stands for them.
- **Yup has no union**, so `yup.lazy` picks the schema of the variant, which is what its users do. Its synchronous API throws on invalid input and is timed inside `try/catch`.
- **afora does more per value** in the rows named `Record`, `Subclass`, `Entity` and `new Record`: they create an instance, and an entity also makes its id and time stamps. `blueprint.safeParse` is the row that does what the other libraries do. It also returns frozen values, which the others do not.

## Contesting a row

If a library is used here in a way that is slower than it has to be, open a pull request that changes its schema in `scenarios/<id>.ts` or its adapter in `contenders.ts`. It is accepted when the row still passes `verify` and keeps the rules above (strict objects, every error collected).

## What CI holds

`bun run bench:guard` times `blueprint.safeParse` and Zod 4 `safeParse` on every case, taking turns in one process, and fails when afora is over the limit of the case as a multiple of Zod 4. It compares a ratio, so it does not depend on the machine. Each contender runs for 400 ms (the warm-up of a row, `warmUp` in `harness.ts`) before its first round, so that no ratio is taken on code the engine has not optimized yet; it takes about 75 seconds. The limits and the reason for each are in `guard.limits.ts`.

Two more checks run on a pull request (`.github/workflows/bench-compare.yml`):

- **Against the base.** `bun run bench -- --compare <checkout of the base>` builds afora from both checkouts and times `blueprint.safeParse`, `Record.safeParse` and `Entity.safeParse` of each on every case, taking turns in one process, after the same warm-up as the guard. A `blueprint.safeParse` row over 1.1x its base fails; the table goes to the summary of the job and to a comment on the pull request. The same code against itself, in three runs on a laptop, stays within 5% on `blueprint.safeParse` and within 12% on the other rows.
- **CodSpeed**, once its app is installed on the repository and the variable `CODSPEED_ENABLED` is `true`: `codspeed.ts` runs the cases of the guard on a simulated CPU, which does not move with the load of the runner, and keeps their history.

## Publishing the results

The `Benchmark results` workflow (`.github/workflows/bench.yml`; by hand, after a release, or for any commit with `git push origin <commit>:bench-results/now`) runs everything on a GitHub runner and opens a pull request with `results/latest.json`, `results/history/<version>.json`, `RESULTS.md`, `results/chart.svg` and the block of the root README between `<!-- bench:start -->` and `<!-- bench:end -->`. All of them are generated: `bun run bench -- --render` writes them again from `results/latest.json`, and `bun run bench:check` (in CI) fails when one was edited by hand. `results/latest.json` is the contract for anything that draws these numbers (`Report` in `render.ts`): `schema` is raised by a change that breaks a reader. Schema 2 has a run per Node version, and the cold start of each library by the version of the runtime (`"Node v24.11.0"`) instead of by `bun` and `node`; `render.ts` reads both.
