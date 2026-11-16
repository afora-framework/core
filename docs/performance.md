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

![Validations per second on the body of an API request, Node v24.22.2](../bench/results/chart.svg)

Time of each library as a multiple of afora `blueprint.safeParse` on the same case: above 1.00x it is slower than afora, below it is faster. TypeBox, Ajv and Typia only check, they do not transform. afora 27.0.0-rc.4, Bun 1.4.4, Node v22.23.4 and Node v24.22.2, AMD EPYC 9V74 80-Core Processor; generated from `bench/results/latest.json`.

| Node 24                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |    Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | -----: | -----: |
| Small flat object, valid                                 | 319.2 ns |   0.21x | 0.21x | 0.22x | 1.67x |   2.78x |  13.59x |         3.55x | 15.54x | 10.53x |
| Small flat object, invalid                               | 698.3 ns |   8.34x | 0.13x | 0.58x | 3.01x |   2.46x |  25.81x |         3.88x | 61.61x |  6.96x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2381 ns |   0.14x | 0.22x | 0.15x | 1.65x |   1.43x |  16.87x |         3.79x | 27.37x |  7.74x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  3529 ns |   9.81x | 0.16x | 0.89x | 1.91x |   1.41x |  22.16x |         3.97x | 41.64x |  6.87x |
| API request body (an order with 5 items), valid          |  2662 ns |   0.43x | 0.44x | 0.29x | 1.73x |   1.62x |  12.17x |         3.22x | 22.51x |  7.20x |
| API request body (an order with 5 items), invalid        |  4517 ns |   4.98x | 0.15x | 0.92x | 1.99x |   1.22x |  15.76x |         2.91x | 32.56x |  5.41x |
| List of 1,000 items, valid                               | 167.7 µs |   0.08x | 0.13x | 0.09x | 0.96x |   3.49x |  25.50x |         4.63x | 37.37x | 10.49x |
| List of 1,000 items, invalid                             | 171.9 µs |  23.60x | 0.14x | 0.23x | 0.97x |   3.55x |  33.30x |         4.64x | 37.48x | 10.28x |
| Union of 4 variants (12 events), valid                   | 875.6 ns |   0.47x | 0.57x | 0.47x | 4.14x |  15.18x |   1.57x |        11.25x | 91.57x | 87.76x |
| Union of 4 variants (12 events), invalid                 |  4339 ns |  10.52x | 0.13x | 0.57x | 1.48x |   3.59x |   5.77x |         2.71x | 26.43x | 30.02x |
| 6 levels of nesting, valid                               |  1105 ns |   0.06x | 0.10x | 0.07x | 0.91x |   1.29x |  14.88x |         4.30x | 20.58x |  5.91x |
| 6 levels of nesting, invalid                             |  1651 ns |  16.55x | 0.08x | 1.33x | 1.82x |   1.49x |  21.61x |         4.34x | 43.83x |  5.87x |
| Small flat object, checks only, valid                    | 181.5 ns |   0.37x | 0.37x | 0.39x | 1.21x |   3.87x |   0.64x |         3.59x | 24.56x | 17.10x |
| Small flat object, checks only, invalid                  | 656.2 ns |   8.90x | 0.14x | 0.61x | 2.81x |   2.48x |  21.79x |         3.59x | 65.31x |  7.33x |

| Bun                                                      |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |     Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | ------: |
| Small flat object, valid                                 | 246.8 ns |   0.18x | 0.21x | 0.20x | 1.96x |   1.03x |  12.44x |         2.92x |  24.34x |  12.87x |
| Small flat object, invalid                               | 642.2 ns |   6.10x | 0.21x | 1.05x | 1.43x |   0.90x |  14.58x |         2.39x |  37.75x |   8.43x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1779 ns |   0.13x | 0.22x | 0.08x | 2.26x |   1.04x |  11.51x |         3.74x |  42.34x |   9.74x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2707 ns |   8.86x | 0.19x | 1.18x | 1.96x |   1.09x |  15.39x |         3.23x |  47.19x |   8.82x |
| API request body (an order with 5 items), valid          |  1756 ns |   0.42x | 0.37x | 0.53x | 2.54x |   1.33x |   9.70x |         3.60x |  43.83x |   9.97x |
| API request body (an order with 5 items), invalid        |  3175 ns |   4.88x | 0.15x | 1.11x | 2.18x |   1.05x |  12.13x |         2.54x |  41.21x |   8.13x |
| List of 1,000 items, valid                               |  93.2 µs |   0.06x | 0.16x | 0.04x | 2.86x |   1.29x |  19.73x |         4.58x |  84.34x |  13.53x |
| List of 1,000 items, invalid                             |  98.8 µs |  27.74x | 0.17x | 0.58x | 2.92x |   1.28x |  31.56x |         4.43x |  80.65x |  13.88x |
| Union of 4 variants (12 events), valid                   | 522.7 ns |   0.48x | 0.63x | 0.74x | 8.36x |   9.15x |   1.20x |        11.14x | 176.79x | 127.33x |
| Union of 4 variants (12 events), invalid                 |  3028 ns |  10.88x | 0.14x | 0.76x | 1.99x |   2.09x |   3.99x |         2.50x |  34.89x |  38.18x |
| 6 levels of nesting, valid                               | 707.7 ns |   0.03x | 0.11x | 0.06x | 2.26x |   1.46x |  12.54x |         3.41x |  42.11x |   9.08x |
| 6 levels of nesting, invalid                             |  1126 ns |  16.66x | 0.10x | 1.49x | 1.91x |   1.53x |  18.45x |         3.43x |  52.23x |   8.57x |
| Small flat object, checks only, valid                    |  94.9 ns |   0.48x | 0.56x | 0.52x | 3.23x |   1.65x |   0.59x |         3.65x |  57.12x |  24.19x |
| Small flat object, checks only, invalid                  | 652.6 ns |   6.01x | 0.21x | 1.04x | 1.35x |   0.78x |  10.42x |         1.90x |  36.29x |   7.44x |

| Node 22                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | -----: |
| Small flat object, valid                                 | 319.4 ns |   0.20x | 0.20x | 0.20x | 1.70x |   1.32x |  13.40x |         3.25x |  16.85x | 10.62x |
| Small flat object, invalid                               | 664.9 ns |   8.67x | 0.15x | 0.63x | 2.99x |   1.00x |  27.30x |         4.19x | 119.56x |  7.10x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2342 ns |   0.16x | 0.27x | 0.16x | 1.67x |   1.45x |  17.17x |         3.88x |  32.37x |  7.79x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  3353 ns |  10.28x | 0.22x | 0.92x | 2.07x |   1.43x |  23.91x |         3.95x |  65.63x |  7.10x |
| API request body (an order with 5 items), valid          |  2488 ns |   0.42x | 0.51x | 0.28x | 1.83x |   1.72x |  13.47x |         3.31x |  29.20x |  8.00x |
| API request body (an order with 5 items), invalid        |  4394 ns |   5.00x | 0.18x | 0.90x | 2.03x |   1.27x |  15.71x |         2.65x |  51.77x |  5.40x |
| List of 1,000 items, valid                               | 161.6 µs |   0.07x | 0.15x | 0.08x | 1.04x |   1.61x |  27.97x |         4.62x |  46.28x | 10.24x |
| List of 1,000 items, invalid                             | 165.0 µs |  24.16x | 0.17x | 0.24x | 1.04x |   1.59x |  37.00x |         4.58x |  49.82x | 10.45x |
| Union of 4 variants (12 events), valid                   | 811.5 ns |   0.50x | 0.67x | 0.52x | 4.52x |   8.80x |   2.15x |        11.66x | 116.92x | 94.77x |
| Union of 4 variants (12 events), invalid                 |  4159 ns |  10.87x | 0.14x | 0.59x | 1.61x |   2.12x |   6.22x |         2.96x |  37.31x | 30.84x |
| 6 levels of nesting, valid                               |  1089 ns |   0.07x | 0.11x | 0.08x | 0.90x |   1.33x |  15.22x |         4.01x |  25.00x |  6.25x |
| 6 levels of nesting, invalid                             |  1638 ns |  16.28x | 0.09x | 1.45x | 1.82x |   1.53x |  22.41x |         4.33x |  70.30x |  6.13x |
| Small flat object, checks only, valid                    | 163.0 ns |   0.43x | 0.40x | 0.40x | 1.41x |   1.79x |   0.87x |         3.79x |  31.26x | 19.25x |
| Small flat object, checks only, invalid                  | 687.8 ns |   8.52x | 0.14x | 0.64x | 2.60x |   0.88x |  20.78x |         3.41x | 114.64x |  6.92x |

<!-- bench:end -->

What the tables say, for `blueprint.safeParse` of afora 0.0.11, on a GitHub runner (AMD EPYC, Linux, Bun 1.4.4, Node 22 and Node 24).

- **Against Zod 4.** On Bun, faster in all 14 cases, by 1.04x (the valid nested object) to 2.55x. On Node, faster in 10 of the 14, by 1.15x to 5.35x; Zod 4 is ahead on the list of 1,000 items (1.4x to 1.5x), on the valid flat object with nothing to transform (1.2x to 1.3x) and on the valid deep object (1.15x to 1.2x). A rejected value of a discriminated union is told by the variant it names, without TypeBox `Errors`: 1.5x to 2x faster than Zod 4.
- **Against Valibot.** On Node 24 afora is faster in all 14 cases, by 1.08x to 3.7x outside the valid union (15x); on Node 22 in 12 of them, Valibot being ahead by 4% to 9% on the invalid flat objects. On Bun it is the other way: Valibot is ahead in 10 of them, by 3% to 27% on the small objects and the invalid inputs, by 1.4x on the valid API body and by 2x on the valid nested object and the valid list; afora is ahead on the deep object (1.4x to 1.5x) and the union (2.2x to 3x).
- **Against Effect Schema, Joi and Yup.** Faster in every case: 1.7x to 5.1x Effect Schema, 4.2x to 15x Joi and 11x to 122x Yup outside the union, and up to 14x, 109x and 137x on the union.
- **Against ArkType.** Faster wherever a value is transformed or rejected, by 4.2x to 26x, because its morphs and its errors take a slower path. With nothing to transform and a valid value, ArkType is 1.9x to 2.8x faster than afora, and 2.8x on the valid union on Bun.
- **Floor.** The checkers that compile and do not transform (TypeBox, Ajv, Typia) are 3x to 7x faster than afora on a valid small object (down to 1.3x on the valid union on Node), and 5x to 50x on the larger ones. afora builds on TypeBox. On invalid input afora is 4.3x to 19x faster than TypeBox `Errors`, and Ajv stays 5x to 11x ahead.
- **Records and entities.** `Record.safeParse`, which also creates the instance, takes 1.0x to 1.9x the time of `blueprint.safeParse` on Bun and up to 3.7x on Node. `Entity.safeParse` also makes an id and the time stamps, only once the rest of the value is valid: 1.0x to 1.7x `blueprint.safeParse` on the larger objects on Bun (up to 3.1x on Node), and 2.3x to 3.9x on the small ones (up to 5.7x on Node), where making them is most of its time. `Entity.safeParse (a stored row)` is an entity read back from a repository, with its `id` and `createdAt` given and checked. A `date-time` or `date` string in the form `toISOString` writes is checked without TypeBox's regular expressions (anything else is left to TypeBox, so the same strings are accepted), which is most of what a stored row used to cost. A blueprint whose fields only check their value against a schema, with no handler, is checked by one compiled check of the whole value once it has parsed a few values. `new Record(value)` throws on invalid input, which costs an exception with its trace (up to 6x `blueprint.safeParse` on Bun and 17.5x on Node); use `safeParse` where invalid input is expected.
- **Bundle and cold start.** afora is a framework with one entry point: validating one object bundles to 190 kB minified and 54 kB gzipped (Zod 4: 87 kB and 25 kB, Valibot: 1.7 kB gzipped) and takes 15 ms to load, build and run once in a new Node process (18 ms on Bun; Zod 4: about 9 ms).

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
