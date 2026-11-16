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

Time of each library as a multiple of afora `blueprint.safeParse` on the same case: above 1.00x it is slower than afora, below it is faster. TypeBox, Ajv and Typia only check, they do not transform. afora 27.0.0-rc.3, Bun 1.4.4, Node v22.23.4 and Node v24.22.2, AMD EPYC 9V74 80-Core Processor; generated from `bench/results/latest.json`.

| Node 24                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |    Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | -----: | -----: |
| Small flat object, valid                                 | 328.1 ns |   0.20x | 0.20x | 0.21x | 1.67x |   2.66x |  13.19x |         3.48x | 14.97x | 10.32x |
| Small flat object, invalid                               | 739.5 ns |   7.99x | 0.13x | 0.53x | 2.85x |   2.21x |  24.42x |         3.68x | 58.31x |  6.75x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2383 ns |   0.14x | 0.21x | 0.16x | 1.66x |   1.39x |  16.77x |         3.90x | 26.45x |  7.82x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  3593 ns |   9.43x | 0.17x | 0.88x | 1.91x |   1.33x |  21.82x |         3.83x | 41.32x |  6.85x |
| API request body (an order with 5 items), valid          |  2591 ns |   0.45x | 0.45x | 0.31x | 1.79x |   1.64x |  12.57x |         3.39x | 23.27x |  7.46x |
| API request body (an order with 5 items), invalid        |  4413 ns |   5.07x | 0.15x | 0.94x | 2.03x |   1.27x |  15.97x |         2.99x | 33.29x |  5.53x |
| List of 1,000 items, valid                               | 169.2 µs |   0.08x | 0.13x | 0.09x | 0.93x |   3.33x |  25.51x |         4.60x | 36.01x | 10.46x |
| List of 1,000 items, invalid                             | 170.8 µs |  23.77x | 0.14x | 0.23x | 0.95x |   3.27x |  32.36x |         4.73x | 38.52x | 10.33x |
| Union of 4 variants (12 events), valid                   | 876.8 ns |   0.46x | 0.57x | 0.47x | 4.16x |  13.61x |   1.59x |        11.40x | 90.19x | 88.30x |
| Union of 4 variants (12 events), invalid                 |  4329 ns |  10.50x | 0.12x | 0.55x | 1.46x |   3.45x |   5.77x |         3.09x | 26.51x | 30.31x |
| 6 levels of nesting, valid                               |  1110 ns |   0.07x | 0.10x | 0.07x | 0.91x |   1.29x |  14.88x |         4.22x | 20.55x |  5.88x |
| 6 levels of nesting, invalid                             |  1721 ns |  15.86x | 0.08x | 1.27x | 1.70x |   1.46x |  20.58x |         4.14x | 42.43x |  5.67x |
| Small flat object, checks only, valid                    | 183.3 ns |   0.35x | 0.37x | 0.37x | 1.20x |   3.93x |   0.62x |         3.62x | 24.55x | 16.91x |
| Small flat object, checks only, invalid                  | 727.7 ns |   8.03x | 0.13x | 0.54x | 2.48x |   2.09x |  19.60x |         3.21x | 59.10x |  6.54x |

| Bun                                                      |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |     Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | ------: |
| Small flat object, valid                                 | 251.1 ns |   0.18x | 0.21x | 0.19x | 1.88x |   1.02x |  11.81x |         2.85x |  23.45x |  12.04x |
| Small flat object, invalid                               | 621.7 ns |   5.97x | 0.21x | 1.08x | 1.41x |   0.90x |  14.71x |         2.41x |  37.05x |   7.73x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1741 ns |   0.13x | 0.24x | 0.09x | 2.25x |   1.05x |  10.88x |         3.66x |  42.86x |   9.18x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2610 ns |   8.85x | 0.20x | 1.14x | 1.85x |   1.08x |  15.55x |         3.19x |  45.64x |   8.45x |
| API request body (an order with 5 items), valid          |  1720 ns |   0.38x | 0.39x | 0.56x | 2.44x |   1.35x |   9.57x |         3.59x |  40.89x |   9.51x |
| API request body (an order with 5 items), invalid        |  3047 ns |   4.83x | 0.16x | 1.12x | 2.13x |   1.07x |  12.24x |         2.49x |  41.42x |   7.68x |
| List of 1,000 items, valid                               |  93.8 µs |   0.06x | 0.16x | 0.04x | 2.86x |   1.27x |  19.51x |         4.36x |  79.31x |  13.22x |
| List of 1,000 items, invalid                             |  97.0 µs |  26.76x | 0.18x | 0.55x | 2.82x |   1.31x |  31.16x |         4.30x |  82.97x |  13.67x |
| Union of 4 variants (12 events), valid                   | 509.6 ns |   0.48x | 0.68x | 0.76x | 8.32x |   9.99x |   1.26x |        11.51x | 166.97x | 134.57x |
| Union of 4 variants (12 events), invalid                 |  3015 ns |  10.49x | 0.14x | 0.77x | 1.88x |   2.04x |   3.99x |         2.45x |  34.41x |  37.67x |
| 6 levels of nesting, valid                               | 711.1 ns |   0.03x | 0.11x | 0.06x | 2.08x |   1.43x |  12.10x |         3.39x |  39.56x |   8.10x |
| 6 levels of nesting, invalid                             |  1214 ns |  14.88x | 0.09x | 1.34x | 1.76x |   1.40x |  16.34x |         3.11x |  47.08x |   7.89x |
| Small flat object, checks only, valid                    |  95.5 ns |   0.47x | 0.56x | 0.48x | 3.17x |   1.60x |   0.59x |         3.55x |  55.78x |  24.13x |
| Small flat object, checks only, invalid                  | 619.5 ns |   6.09x | 0.21x | 1.09x | 1.32x |   0.81x |  10.76x |         1.84x |  37.00x |   7.24x |

| Node 22                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | -----: |
| Small flat object, valid                                 | 332.0 ns |   0.20x | 0.19x | 0.20x | 1.70x |   1.26x |  13.30x |         3.13x |  15.63x |  9.97x |
| Small flat object, invalid                               | 688.5 ns |   8.22x | 0.14x | 0.63x | 2.86x |   0.97x |  26.33x |         4.00x | 114.23x |  6.91x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  2315 ns |   0.16x | 0.27x | 0.16x | 1.69x |   1.43x |  17.30x |         3.84x |  32.68x |  7.79x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  3485 ns |   9.74x | 0.21x | 0.90x | 2.01x |   1.37x |  23.25x |         3.55x |  63.42x |  6.96x |
| API request body (an order with 5 items), valid          |  2507 ns |   0.42x | 0.51x | 0.29x | 1.81x |   1.72x |  13.15x |         3.19x |  28.83x |  7.63x |
| API request body (an order with 5 items), invalid        |  4245 ns |   5.12x | 0.18x | 0.93x | 2.10x |   1.32x |  16.12x |         2.81x |  53.21x |  5.71x |
| List of 1,000 items, valid                               | 163.4 µs |   0.07x | 0.15x | 0.08x | 1.01x |   1.56x |  27.36x |         4.46x |  47.84x | 10.25x |
| List of 1,000 items, invalid                             | 166.5 µs |  23.81x | 0.17x | 0.25x | 1.03x |   1.59x |  37.24x |         4.48x |  50.52x | 10.22x |
| Union of 4 variants (12 events), valid                   | 814.9 ns |   0.50x | 0.67x | 0.50x | 4.46x |   8.99x |   2.12x |        11.70x | 115.94x | 92.52x |
| Union of 4 variants (12 events), invalid                 |  4033 ns |  11.04x | 0.14x | 0.59x | 1.63x |   2.15x |   6.37x |         2.93x |  37.74x | 31.41x |
| 6 levels of nesting, valid                               |  1078 ns |   0.07x | 0.11x | 0.07x | 0.91x |   1.34x |  15.20x |         3.90x |  24.07x |  6.10x |
| 6 levels of nesting, invalid                             |  1613 ns |  16.48x | 0.09x | 1.47x | 1.77x |   1.54x |  22.61x |         4.33x |  71.67x |  5.98x |
| Small flat object, checks only, valid                    | 166.4 ns |   0.38x | 0.39x | 0.39x | 1.43x |   1.75x |   0.85x |         3.59x |  29.00x | 18.74x |
| Small flat object, checks only, invalid                  | 669.9 ns |   8.58x | 0.14x | 0.65x | 2.53x |   0.90x |  21.27x |         3.47x | 116.26x |  6.91x |

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
