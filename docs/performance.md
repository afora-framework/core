# Performance

How fast afora validates, how that is measured, and what CI does to keep it from getting slower. The numbers below are generated from the committed run (`bench/results/latest.json`). They change with the machine, so read the ratios, and read [bench/RESULTS.md](../bench/RESULTS.md) for the full tables. Performance numbers are not part of the [contract](../VERSIONING.md).

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

afora does more per value than a checker: it normalizes, collects every issue, and returns a new value (records freeze theirs). TypeBox, Ajv and Typia only check, so they are faster on valid input and are marked "no transforms" in the tables.

<!-- bench:start -->

![Validations per second on the body of an API request, Node v24.22.3](../bench/results/chart.svg)

Time of each library as a multiple of afora `blueprint.safeParse` on the same case: above 1.00x it is slower than afora, below it is faster. TypeBox, Ajv and Typia only check, they do not transform. afora 27.0.0-rc.6, Bun 1.4.4, Node v22.23.5 and Node v24.22.3, Intel(R) Xeon(R) 6975P-C; generated from `bench/results/latest.json`.

| Node 24                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |    Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | -----: | -----: |
| Small flat object, valid                                 | 303.1 ns |   0.20x | 0.21x | 0.22x | 1.39x |   2.33x |  11.94x |         2.69x | 13.59x |  8.77x |
| Small flat object, invalid                               | 695.8 ns |   6.55x | 0.15x | 0.53x | 1.97x |   1.98x |  22.25x |         2.73x | 55.41x |  5.56x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2230 ns |   0.15x | 0.28x | 0.15x | 1.35x |   1.32x |  15.94x |         3.07x | 23.54x |  6.50x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2977 ns |   9.23x | 0.24x | 0.88x | 1.82x |   1.47x |  22.10x |         3.22x | 42.98x |  6.51x |
| API request body (an order with 5 items), valid          |  2138 ns |   0.43x | 0.49x | 0.32x | 1.56x |   1.69x |  13.48x |         3.01x | 23.54x |  7.32x |
| API request body (an order with 5 items), invalid        |  3561 ns |   5.30x | 0.19x | 0.96x | 1.95x |   1.23x |  16.44x |         2.54x | 36.72x |  5.61x |
| List of 1,000 items, valid                               | 160.2 µs |   0.08x | 0.13x | 0.07x | 0.76x |   3.39x |  22.93x |         3.72x | 31.29x |  7.47x |
| List of 1,000 items, invalid                             | 158.7 µs |  20.15x | 0.15x | 0.23x | 0.81x |   3.41x |  30.81x |         3.79x | 33.29x |  7.88x |
| Union of 4 variants (12 events), valid                   | 778.1 ns |   0.49x | 0.68x | 0.50x | 3.26x |  13.18x |   1.56x |         9.31x | 84.17x | 75.94x |
| Union of 4 variants (12 events), invalid                 |  3147 ns |  11.61x | 0.18x | 0.64x | 1.49x |   4.15x |   7.11x |         2.82x | 31.33x | 33.11x |
| 6 levels of nesting, valid                               |  1001 ns |   0.06x | 0.11x | 0.07x | 0.80x |   1.33x |  15.49x |         3.44x | 19.60x |  5.07x |
| 6 levels of nesting, invalid                             |  1385 ns |  15.37x | 0.10x | 1.33x | 1.67x |   1.59x |  22.93x |         3.84x | 46.58x |  5.87x |
| Small flat object, checks only, valid                    | 177.2 ns |   0.34x | 0.36x | 0.38x | 1.13x |   3.36x |   0.62x |         2.81x | 21.53x | 13.38x |
| Small flat object, checks only, invalid                  | 663.6 ns |   6.79x | 0.15x | 0.55x | 1.76x |   2.01x |  17.16x |         2.51x | 59.26x |  5.69x |

| Bun                                                      |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | -----: |
| Small flat object, valid                                 | 233.8 ns |   0.18x | 0.23x | 0.20x | 1.67x |   1.02x |  10.64x |         2.35x |  19.53x |  8.66x |
| Small flat object, invalid                               | 532.7 ns |   5.33x | 0.20x | 1.09x | 1.31x |   0.87x |  13.59x |         1.94x |  37.90x |  7.08x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1517 ns |   0.13x | 0.26x | 0.09x | 2.08x |   1.02x |  12.60x |         3.34x |  37.45x |  7.67x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2194 ns |   8.09x | 0.23x | 1.03x | 1.74x |   1.10x |  16.62x |         2.91x |  44.07x |  7.84x |
| API request body (an order with 5 items), valid          |  1352 ns |   0.44x | 0.50x | 0.68x | 2.44x |   1.42x |  11.42x |         3.53x |  41.62x |  9.10x |
| API request body (an order with 5 items), invalid        |  2507 ns |   4.75x | 0.18x | 1.06x | 2.04x |   1.09x |  13.15x |         2.44x |  40.24x |  7.75x |
| List of 1,000 items, valid                               |  76.9 µs |   0.07x | 0.20x | 0.04x | 2.84x |   1.30x |  21.76x |         4.38x |  73.40x | 11.48x |
| List of 1,000 items, invalid                             |  78.8 µs |  25.99x | 0.22x | 0.52x | 2.98x |   1.31x |  32.56x |         4.31x |  79.75x | 12.03x |
| Union of 4 variants (12 events), valid                   | 485.6 ns |   0.49x | 0.74x | 0.66x | 6.10x |   7.36x |   1.21x |         8.34x | 142.10x | 96.26x |
| Union of 4 variants (12 events), invalid                 |  2168 ns |  11.11x | 0.19x | 0.83x | 1.85x |   2.11x |   4.75x |         2.43x |  38.91x | 43.01x |
| 6 levels of nesting, valid                               | 571.1 ns |   0.03x | 0.13x | 0.07x | 2.19x |   1.70x |  13.98x |         3.23x |  39.71x |  7.27x |
| 6 levels of nesting, invalid                             | 942.1 ns |  14.48x | 0.11x | 1.26x | 1.69x |   1.75x |  19.61x |         3.02x |  51.30x |  7.81x |
| Small flat object, checks only, valid                    |  84.1 ns |   0.52x | 0.64x | 0.53x | 3.02x |   1.36x |   0.57x |         3.15x |  49.30x | 17.80x |
| Small flat object, checks only, invalid                  | 506.2 ns |   5.66x | 0.21x | 1.17x | 1.24x |   0.82x |  10.68x |         1.63x |  36.71x |  6.46x |

| Node 22                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | -----: |
| Small flat object, valid                                 | 295.8 ns |   0.20x | 0.21x | 0.22x | 1.44x |   1.26x |  12.28x |         2.64x |  13.36x |  8.63x |
| Small flat object, invalid                               | 573.8 ns |   7.84x | 0.16x | 0.71x | 2.43x |   0.99x |  27.29x |         3.35x | 121.88x |  6.68x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2159 ns |   0.15x | 0.30x | 0.16x | 1.37x |   1.38x |  16.53x |         3.15x |  27.08x |  6.38x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2874 ns |   9.36x | 0.26x | 0.97x | 1.80x |   1.41x |  23.67x |         3.29x |  65.10x |  6.43x |
| API request body (an order with 5 items), valid          |  2133 ns |   0.39x | 0.50x | 0.28x | 1.56x |   1.61x |  13.82x |         2.95x |  27.06x |  7.21x |
| API request body (an order with 5 items), invalid        |  3436 ns |   5.45x | 0.21x | 1.04x | 1.95x |   1.29x |  17.66x |         2.68x |  57.52x |  5.62x |
| List of 1,000 items, valid                               | 152.3 µs |   0.06x | 0.14x | 0.06x | 0.80x |   1.58x |  25.04x |         3.78x |  39.98x |  8.02x |
| List of 1,000 items, invalid                             | 161.4 µs |  19.97x | 0.19x | 0.21x | 0.80x |   1.57x |  32.08x |         3.62x |  41.69x |  7.86x |
| Union of 4 variants (12 events), valid                   | 717.0 ns |   0.50x | 0.73x | 0.53x | 3.56x |   8.32x |   2.04x |         9.97x | 106.77x | 80.98x |
| Union of 4 variants (12 events), invalid                 |  2905 ns |  12.24x | 0.20x | 0.71x | 1.70x |   2.46x |   7.92x |         3.08x |  45.17x | 34.35x |
| 6 levels of nesting, valid                               | 976.2 ns |   0.05x | 0.11x | 0.07x | 0.80x |   1.38x |  15.31x |         3.34x |  21.70x |  5.26x |
| 6 levels of nesting, invalid                             |  1317 ns |  15.76x | 0.11x | 1.69x | 1.69x |   1.67x |  24.69x |         4.01x |  78.99x |  5.99x |
| Small flat object, checks only, valid                    | 168.9 ns |   0.35x | 0.38x | 0.38x | 1.14x |   1.57x |   0.74x |         2.84x |  21.02x | 14.30x |
| Small flat object, checks only, invalid                  | 537.9 ns |   8.30x | 0.17x | 0.78x | 2.20x |   0.97x |  21.82x |         3.07x | 129.46x |  6.77x |

<!-- bench:end -->

What the tables say, for `blueprint.safeParse` of afora 0.0.11, on a GitHub runner (AMD EPYC, Linux, Bun 1.4.4, Node 22 and Node 24).

- **Against Zod 4.** On Bun, faster in all 14 cases, by 1.04x (the valid nested object) to 2.55x. On Node, faster in 10 of the 14, by 1.15x to 5.35x; Zod 4 is ahead on the list of 1,000 items (1.4x to 1.5x), on the valid flat object with nothing to transform (1.2x to 1.3x) and on the valid deep object (1.15x to 1.2x). A rejected value of a discriminated union is told by the variant it names, without TypeBox `Errors`: 1.5x to 2x faster than Zod 4.
- **Against Valibot.** On Node 24 afora is faster in all 14 cases, by 1.08x to 3.7x outside the valid union (15x); on Node 22 in 12 of them, Valibot being ahead by 4% to 9% on the invalid flat objects. On Bun it is the other way: Valibot is ahead in 10 of them, by 3% to 27% on the small objects and the invalid inputs, by 1.4x on the valid API body and by 2x on the valid nested object and the valid list; afora is ahead on the deep object (1.4x to 1.5x) and the union (2.2x to 3x).
- **Against Effect Schema, Joi and Yup.** Faster in every case: 1.7x to 5.1x Effect Schema, 4.2x to 15x Joi and 11x to 122x Yup outside the union, and up to 14x, 109x and 137x on the union.
- **Against ArkType.** Faster wherever a value is transformed or rejected, by 4.2x to 26x, because its morphs and its errors take a slower path. With nothing to transform and a valid value, ArkType is 1.9x to 2.8x faster than afora, and 2.8x on the valid union on Bun.
- **Floor.** The checkers that compile and do not transform (TypeBox, Ajv, Typia) are 3x to 7x faster than afora on a valid small object (down to 1.3x on the valid union on Node), and 5x to 50x on the larger ones. afora builds on TypeBox. On invalid input afora is 4.3x to 19x faster than TypeBox `Errors`, and Ajv stays 5x to 11x ahead.
- **Records and entities.** `Record.safeParse`, which also creates the instance, takes 1.0x to 1.9x the time of `blueprint.safeParse` on Bun and up to 3.7x on Node. `Entity.safeParse` also makes an id and the time stamps, only once the rest of the value is valid: 1.0x to 1.7x `blueprint.safeParse` on the larger objects on Bun (up to 3.1x on Node), and 2.3x to 3.9x on the small ones (up to 5.7x on Node), where making them is most of its time. `Entity.safeParse (a stored row)` is an entity read back from a repository, with its `id` and `createdAt` given and checked. A `date-time` or `date` string in the form `toISOString` writes is checked without TypeBox's regular expressions (anything else is left to TypeBox, so the same strings are accepted), which is most of what a stored row used to cost. A blueprint whose fields only check their value against a schema, with no handler, is checked by one compiled check of the whole value once it has parsed a few values. `new Record(value)` throws on invalid input, which costs an exception with its trace (up to 6x `blueprint.safeParse` on Bun and 17.5x on Node); use `safeParse` where invalid input is expected.
- **Bundle and cold start.** Validating one object bundles to 190 kB minified and 54 kB gzipped (Zod 4: 87 kB and 25 kB, Valibot: 1.7 kB gzipped) and takes 15 ms to load, build and run once in a new Node process (18 ms on Bun; Zod 4: about 9 ms). Most of it is TypeBox, its schemas and its formats, and the properties of the Std catalog: a bundler that drops unused modules already leaves out records, entities, repositories and use cases. The same file importing from `@afora/core/client`, the entry for interfaces that reaches none of those modules, is no smaller: both measured 209 kB minified and 60.0 kB gzipped in November 2026, on a newer version than the numbers above, and `bun run bench:guard` holds it under 62 kB gzipped (`SIZE_LIMITS` in `bench/guard.limits.ts`).

What afora does that the fast rows do not all do: a pipeline per property (`preHandle`, schema check, `afterHandle`), where a property with a handler has the shape of the value checked first, so handlers only see the right types; objects walked key by key instead of one compiled function; a new value made for each call (frozen in a record); every issue with `code`, `path` and `source`; and, for `Record.safeParse` and `new Record`, creating the instance. If you validate bulk data in a hot path and need none of that, a compiled checker alone is an order of magnitude faster.

CI keeps it there: `bun run bench:guard` times `blueprint.safeParse` and Zod 4 `safeParse` on the fourteen cases and fails when afora is over the limit of a case as a multiple of Zod 4 (1.15x unless `bench/guard.limits.ts` states another, with the reason); `Entity.safeParse` is held the same way, to the limits of `ENTITY_LIMITS`.

## Against other validators

A rough guide, not a verdict. "Partial" means it is possible but not what the library is for.

|                             | afora                                         | Zod 4         | Valibot        | Effect Schema                      |
| --------------------------- | --------------------------------------------- | ------------- | -------------- | ---------------------------------- |
| Standard Schema V1          | yes, on every field                           | yes           | yes            | yes                                |
| Transforms                  | yes (`preHandle`, `afterHandle`)              | yes           | yes            | yes                                |
| Domain entities / classes   | yes (records with change methods and effects) | no            | no             | partial (`Schema.Class`)           |
| Sensitive masking           | yes (`sensitive`, in `toJSON`)                | no            | no             | partial (`Redacted`)               |
| Layered errors with a trace | yes (`ExceptionLayers`, `trace`)              | no            | no             | partial (tagged errors, no layers) |
| Runtime speed               | ahead of Zod 4 on most cases; see above       | see above     | see above      | slower than afora in every case    |
| Bundle size                 | 54 kB gzipped (carries TypeBox)               | 25 kB gzipped | small, modular | larger                             |
| Ecosystem and maturity      | new, small                                    | very large    | large          | large, in the Effect ecosystem     |

Where the others win: compiled checkers are faster on valid input, Valibot is ahead on several cases on Bun, Zod and Valibot have far larger ecosystems and documentation, and have integrations and code generators for most tools; Valibot is modular and small; Effect Schema fits a codebase already built on Effect. afora gives up those to model entities, masking and layers in the type you already validate with.

## Running it

```bash
bun run bench                      # everything, on Bun and Node; about half an hour
bun run bench -- --only flat,union # some scenarios; prints and writes nothing
bun run bench -- --only flat --rounds 1   # a quick look
bun run bench:guard                # afora against Zod 4, fails over a limit (what CI runs)
bun run bench:check                # README and this page's blocks, RESULTS.md and the chart match latest.json
```

`bun run bench` rewrites `bench/results/latest.json` and `bench/RESULTS.md`, and the chart of the README and the tables of this page are generated from the same file (`bun run bench -- --render` regenerates them without measuring; `bench:check` fails when they are edited by hand). Run it on an idle machine. Node is the `node` on the `PATH`, or each binary in `BENCH_NODE_BINS` (paths separated by `:`):

```bash
BENCH_NODE_BINS="$(mise where node@22)/bin/node:$(mise where node@24)/bin/node" bun run bench -- --only flat
```

## What CI holds

**The guard.** `bun run bench:guard` times `blueprint.safeParse` and Zod 4 `safeParse` on each of the fourteen cases, taking turns in one process, and fails when afora is over the limit of a case, as a multiple of Zod 4. It compares a ratio measured in one process, so it does not depend on the machine, and it takes about 75 seconds. The limit is in `bench/guard.limits.ts`:

| Case       | Limit | Why                                                                        |
| ---------- | ----: | -------------------------------------------------------------------------- |
| every case | 1.15x | afora is at or below Zod 4 there, and 15% is the noise of a shared runner. |

A limit is where afora is plus room for noise, never room for a regression. It is raised only for a cost that is wanted, with the reason written next to it, and the pull request says why. When the guard fails, run it again to rule out noise, then find what the change costs. Run it when you touch `src/core/parse`, `src/core/property`, `src/core/schema` or the constructor of a record.

**Against the base.** A pull request is also timed against its base (`.github/workflows/bench-compare.yml`): `blueprint.safeParse`, `Record.safeParse` and `Entity.safeParse` of both checkouts on every case, and a `blueprint.safeParse` row over 1.1x its base fails. Locally: `bun run bench -- --compare <checkout of the base>`.

**Editor cost.** `bun run test:type-perf` budgets the type instantiations per edit, which is the speed of the editor rather than of the runtime. See [CONTRIBUTING.md](../CONTRIBUTING.md#checks).

## Adding a scenario or a library

Follow [bench/README.md](../bench/README.md): one file per shape in `bench/scenarios/`, the schema of every library side by side, and an adapter in `bench/contenders.ts`. The Typia validators are generated with `bun run typia` in `bench/`, which needs Go.
