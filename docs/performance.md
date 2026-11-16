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

Time of each library as a multiple of afora `blueprint.safeParse` on the same case: above 1.00x it is slower than afora, below it is faster. TypeBox, Ajv and Typia only check, they do not transform. afora 27.0.0-rc.1, Bun 1.4.4, Node v22.23.4 and Node v24.22.2, Intel(R) Xeon(R) 6975P-C; generated from `bench/results/latest.json`.

| Node 24                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |    Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | -----: | -----: |
| Small flat object, valid                                 | 276.8 ns |   0.22x | 0.24x | 0.24x | 1.49x |   2.57x |  13.08x |         2.93x | 13.37x |  9.41x |
| Small flat object, invalid                               | 594.3 ns |   7.70x | 0.17x | 0.61x | 2.27x |   2.36x |  25.65x |         3.29x | 66.14x |  6.87x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1974 ns |   0.17x | 0.32x | 0.17x | 1.49x |   1.50x |  18.42x |         3.44x | 26.30x |  7.34x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2709 ns |  10.20x | 0.27x | 0.98x | 1.96x |   1.61x |  24.29x |         3.49x | 47.23x |  7.21x |
| API request body (an order with 5 items), valid          |  2363 ns |   0.39x | 0.44x | 0.29x | 1.42x |   1.51x |  12.20x |         2.70x | 21.18x |  6.59x |
| API request body (an order with 5 items), invalid        |  3382 ns |   5.63x | 0.20x | 1.03x | 2.11x |   1.29x |  17.23x |         2.71x | 38.93x |  6.00x |
| List of 1,000 items, valid                               | 134.0 µs |   0.09x | 0.16x | 0.08x | 0.91x |   3.87x |  27.84x |         4.40x | 36.83x |  9.01x |
| List of 1,000 items, invalid                             | 135.7 µs |  23.80x | 0.18x | 0.29x | 1.00x |   4.03x |  37.14x |         4.38x | 39.82x |  9.33x |
| Union of 4 variants (12 events), valid                   | 671.8 ns |   0.54x | 0.80x | 0.63x | 3.81x |  15.07x |   1.83x |        10.84x | 96.70x | 88.81x |
| Union of 4 variants (12 events), invalid                 |  3016 ns |  12.67x | 0.18x | 0.70x | 1.59x |   4.41x |   7.43x |         2.95x | 32.63x | 34.32x |
| 6 levels of nesting, valid                               | 881.8 ns |   0.07x | 0.12x | 0.07x | 0.93x |   1.50x |  17.43x |         3.90x | 21.92x |  5.94x |
| 6 levels of nesting, invalid                             |  1278 ns |  17.08x | 0.11x | 1.48x | 1.75x |   1.73x |  25.17x |         4.14x | 49.68x |  6.59x |
| Small flat object, checks only, valid                    | 181.5 ns |   0.35x | 0.35x | 0.37x | 1.07x |   3.17x |   0.61x |         2.76x | 19.98x | 12.97x |
| Small flat object, checks only, invalid                  | 603.4 ns |   7.52x | 0.16x | 0.60x | 1.93x |   2.25x |  19.30x |         2.82x | 64.95x |  6.57x |

| Bun                                                      |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |     Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | ------: |
| Small flat object, valid                                 | 220.6 ns |   0.19x | 0.29x | 0.20x | 1.79x |   1.05x |  11.17x |         2.50x |  20.96x |   9.33x |
| Small flat object, invalid                               | 510.1 ns |   5.54x | 0.20x | 1.16x | 1.35x |   0.92x |  14.74x |         2.01x |  37.87x |   7.27x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1395 ns |   0.14x | 0.28x | 0.10x | 2.29x |   1.12x |  13.61x |         3.60x |  42.01x |   8.39x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2103 ns |   8.44x | 0.25x | 1.11x | 1.85x |   1.17x |  17.68x |         3.08x |  48.06x |   8.28x |
| API request body (an order with 5 items), valid          |  1568 ns |   0.38x | 0.42x | 0.59x | 2.10x |   1.27x |   9.83x |         3.05x |  36.56x |   7.79x |
| API request body (an order with 5 items), invalid        |  2313 ns |   5.31x | 0.21x | 1.25x | 2.23x |   1.19x |  14.11x |         2.69x |  44.31x |   8.47x |
| List of 1,000 items, valid                               |  70.7 µs |   0.07x | 0.21x | 0.05x | 3.10x |   1.47x |  23.77x |         4.86x |  85.59x |  12.57x |
| List of 1,000 items, invalid                             |  76.4 µs |  26.43x | 0.22x | 0.55x | 3.09x |   1.43x |  36.31x |         4.48x |  86.66x |  12.55x |
| Union of 4 variants (12 events), valid                   | 434.8 ns |   0.55x | 0.83x | 0.77x | 6.95x |   8.24x |   1.37x |         9.54x | 162.71x | 109.42x |
| Union of 4 variants (12 events), invalid                 |  2053 ns |  11.83x | 0.21x | 0.88x | 2.03x |   2.22x |   5.01x |         2.59x |  41.30x |  43.74x |
| 6 levels of nesting, valid                               | 509.2 ns |   0.03x | 0.15x | 0.08x | 2.38x |   1.95x |  15.35x |         3.58x |  45.31x |   8.21x |
| 6 levels of nesting, invalid                             | 853.8 ns |  15.86x | 0.12x | 1.39x | 1.83x |   1.95x |  21.42x |         3.30x |  55.82x |   8.45x |
| Small flat object, checks only, valid                    | 108.7 ns |   0.40x | 0.49x | 0.41x | 2.44x |   1.17x |   0.45x |         2.49x |  37.59x |  13.79x |
| Small flat object, checks only, invalid                  | 490.4 ns |   5.67x | 0.21x | 1.21x | 1.31x |   0.84x |  10.96x |         1.68x |  38.35x |   6.78x |

| Node 22                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | -----: |
| Small flat object, valid                                 | 282.2 ns |   0.21x | 0.22x | 0.22x | 1.53x |   1.31x |  12.77x |         2.77x |  14.01x |  9.29x |
| Small flat object, invalid                               | 553.5 ns |   8.00x | 0.17x | 0.76x | 2.53x |   1.04x |  27.76x |         3.51x | 122.70x |  6.87x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  1938 ns |   0.17x | 0.33x | 0.18x | 1.56x |   1.55x |  18.23x |         3.49x |  30.24x |  7.20x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  2605 ns |  10.40x | 0.29x | 1.08x | 2.03x |   1.59x |  26.00x |         3.61x |  72.60x |  7.08x |
| API request body (an order with 5 items), valid          |  2308 ns |   0.36x | 0.46x | 0.27x | 1.45x |   1.50x |  12.74x |         2.73x |  25.06x |  6.65x |
| API request body (an order with 5 items), invalid        |  3222 ns |   5.75x | 0.22x | 1.08x | 2.05x |   1.38x |  18.83x |         2.83x |  61.86x |  5.94x |
| List of 1,000 items, valid                               | 132.4 µs |   0.07x | 0.16x | 0.07x | 0.90x |   1.84x |  29.55x |         4.30x |  45.81x |  9.17x |
| List of 1,000 items, invalid                             | 132.4 µs |  24.49x | 0.23x | 0.26x | 1.01x |   1.86x |  39.48x |         4.37x |  51.02x |  9.51x |
| Union of 4 variants (12 events), valid                   | 582.2 ns |   0.61x | 0.91x | 0.66x | 4.32x |  10.28x |   2.63x |        12.37x | 131.95x | 99.67x |
| Union of 4 variants (12 events), invalid                 |  2776 ns |  13.01x | 0.21x | 0.75x | 1.78x |   2.53x |   8.24x |         3.20x |  47.13x | 35.59x |
| 6 levels of nesting, valid                               | 842.9 ns |   0.06x | 0.13x | 0.08x | 0.91x |   1.59x |  17.75x |         3.85x |  25.18x |  6.11x |
| 6 levels of nesting, invalid                             |  1198 ns |  16.91x | 0.12x | 1.85x | 1.82x |   1.86x |  27.05x |         4.36x |  85.42x |  6.55x |
| Small flat object, checks only, valid                    | 173.4 ns |   0.34x | 0.37x | 0.36x | 1.11x |   1.52x |   0.70x |         2.75x |  20.90x | 13.28x |
| Small flat object, checks only, invalid                  | 498.1 ns |   8.92x | 0.18x | 0.83x | 2.36x |   1.03x |  23.45x |         3.33x | 134.90x |  7.31x |

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
