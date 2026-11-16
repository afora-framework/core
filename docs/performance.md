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

Time of each library as a multiple of afora `blueprint.safeParse` on the same case: above 1.00x it is slower than afora, below it is faster. TypeBox, Ajv and Typia only check, they do not transform. afora 0.0.13, Bun 1.4.4, Node v22.23.4 and Node v24.22.2, AMD EPYC 9V74 80-Core Processor; generated from `bench/results/latest.json`.

| Node 24                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |     Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | ------: |
| Small flat object, valid                                 | 430.0 ns |   0.16x | 0.16x | 0.16x | 1.24x |   2.12x |   9.93x |         2.71x |  11.42x |   7.79x |
| Small flat object, invalid                               | 727.7 ns |   8.00x | 0.13x | 0.57x | 2.96x |   2.31x |  24.86x |         3.76x |  59.88x |   6.70x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  3233 ns |   0.10x | 0.16x | 0.12x | 1.20x |   1.04x |  12.37x |         2.86x |  20.52x |   5.71x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  4091 ns |   8.35x | 0.14x | 0.76x | 1.64x |   1.18x |  18.81x |         3.40x |  35.67x |   5.99x |
| API request body (an order with 5 items), valid          |  3949 ns |   0.30x | 0.29x | 0.19x | 1.16x |   1.08x |   8.17x |         2.16x |  15.23x |   4.95x |
| API request body (an order with 5 items), invalid        |  5228 ns |   4.18x | 0.13x | 0.79x | 1.71x |   1.05x |  13.54x |         2.50x |  28.25x |   4.68x |
| List of 1,000 items, valid                               | 245.4 µs |   0.06x | 0.09x | 0.06x | 0.64x |   2.30x |  17.58x |         3.14x |  24.87x |   7.20x |
| List of 1,000 items, invalid                             | 249.9 µs |  16.21x | 0.10x | 0.16x | 0.65x |   2.33x |  23.24x |         3.15x |  26.52x |   7.10x |
| Union of 4 variants (12 events), valid                   | 743.1 ns |   0.55x | 0.67x | 0.54x | 4.96x |  18.06x |   1.78x |        13.24x | 109.87x | 104.65x |
| Union of 4 variants (12 events), invalid                 |  4157 ns |  10.92x | 0.13x | 0.58x | 1.55x |   3.60x |   6.17x |         3.17x |  27.15x |  31.20x |
| 6 levels of nesting, valid                               |  1157 ns |   0.06x | 0.09x | 0.07x | 0.87x |   1.24x |  14.30x |         4.05x |  20.07x |   5.88x |
| 6 levels of nesting, invalid                             |  1452 ns |  19.13x | 0.09x | 1.53x | 2.05x |   1.71x |  24.58x |         4.93x |  49.57x |   6.66x |
| Small flat object, checks only, valid                    | 293.9 ns |   0.22x | 0.23x | 0.24x | 0.76x |   2.28x |   0.38x |         2.24x |  15.17x |  10.43x |
| Small flat object, checks only, invalid                  | 661.8 ns |   8.84x | 0.14x | 0.63x | 2.74x |   2.54x |  21.57x |         3.59x |  64.77x |   7.09x |

| Bun                                                      |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |    Yup |    Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | -----: | -----: |
| Small flat object, valid                                 | 276.5 ns |   0.16x | 0.19x | 0.18x | 1.74x |   0.91x |  10.93x |         2.56x | 21.02x | 11.14x |
| Small flat object, invalid                               | 658.1 ns |   5.32x | 0.20x | 1.07x | 1.37x |   0.83x |  13.72x |         2.26x | 35.52x |  7.06x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  3779 ns |   0.06x | 0.10x | 0.04x | 1.04x |   0.49x |   5.50x |         1.66x | 18.89x |  4.07x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  3024 ns |   7.76x | 0.17x | 1.00x | 1.66x |   0.93x |  13.42x |         2.70x | 39.32x |  7.16x |
| API request body (an order with 5 items), valid          |  3241 ns |   0.20x | 0.21x | 0.30x | 1.34x |   0.71x |   5.06x |         1.86x | 21.38x |  5.31x |
| API request body (an order with 5 items), invalid        |  3413 ns |   4.54x | 0.15x | 0.99x | 1.89x |   0.92x |  10.97x |         2.30x | 37.81x |  7.09x |
| List of 1,000 items, valid                               | 230.8 µs |   0.03x | 0.07x | 0.02x | 1.15x |   0.52x |   8.02x |         1.85x | 32.56x |  5.41x |
| List of 1,000 items, invalid                             | 138.3 µs |  18.82x | 0.12x | 0.40x | 2.04x |   0.93x |  21.41x |         3.00x | 59.26x |  9.82x |
| Union of 4 variants (12 events), valid                   |  1725 ns |   0.14x | 0.20x | 0.21x | 2.46x |   3.00x |   0.37x |         3.40x | 50.76x | 37.95x |
| Union of 4 variants (12 events), invalid                 |  2933 ns |  11.17x | 0.14x | 0.79x | 1.92x |   2.14x |   4.12x |         2.46x | 36.03x | 40.44x |
| 6 levels of nesting, valid                               | 727.3 ns |   0.03x | 0.11x | 0.06x | 2.15x |   1.39x |  12.19x |         3.37x | 40.57x |  8.92x |
| 6 levels of nesting, invalid                             |  1147 ns |  16.67x | 0.10x | 1.48x | 2.04x |   1.55x |  18.14x |         3.44x | 52.96x |  8.71x |
| Small flat object, checks only, valid                    | 162.5 ns |   0.28x | 0.32x | 0.30x | 1.97x |   0.90x |   0.35x |         2.14x | 35.61x | 15.50x |
| Small flat object, checks only, invalid                  | 656.1 ns |   5.93x | 0.21x | 1.07x | 1.28x |   0.76x |  10.41x |         1.92x | 35.89x |  7.57x |

| Node 22                                                  |    afora | TypeBox |   Ajv | Typia |   Zod | Valibot | ArkType | Effect Schema |     Yup |     Joi |
| -------------------------------------------------------- | -------: | ------: | ----: | ----: | ----: | ------: | ------: | ------------: | ------: | ------: |
| Small flat object, valid                                 | 411.9 ns |   0.16x | 0.16x | 0.16x | 1.33x |   0.99x |  10.19x |         2.62x |  13.52x |   8.04x |
| Small flat object, invalid                               | 709.4 ns |   8.13x | 0.14x | 0.61x | 2.87x |   0.96x |  25.80x |         3.88x | 111.17x |   6.86x |
| Nested user (address, 5 tags max, 10 addresses), valid   |  3101 ns |   0.12x | 0.20x | 0.12x | 1.23x |   1.09x |  13.09x |         3.05x |  24.42x |   5.73x |
| Nested user (address, 5 tags max, 10 addresses), invalid |  4039 ns |   8.39x | 0.18x | 0.78x | 1.70x |   1.20x |  19.55x |         3.28x |  55.05x |   5.83x |
| API request body (an order with 5 items), valid          |  3812 ns |   0.27x | 0.33x | 0.18x | 1.19x |   1.13x |   8.74x |         2.17x |  19.28x |   5.10x |
| API request body (an order with 5 items), invalid        |  5141 ns |   4.28x | 0.16x | 0.76x | 1.78x |   1.09x |  13.39x |         2.33x |  44.35x |   4.78x |
| List of 1,000 items, valid                               | 244.0 µs |   0.05x | 0.10x | 0.05x | 0.68x |   1.05x |  18.46x |         3.09x |  31.25x |   6.98x |
| List of 1,000 items, invalid                             | 243.5 µs |  16.79x | 0.12x | 0.18x | 0.70x |   1.10x |  26.02x |         3.11x |  35.40x |   7.28x |
| Union of 4 variants (12 events), valid                   | 704.9 ns |   0.57x | 0.78x | 0.61x | 5.33x |  10.45x |   2.34x |        14.27x | 138.33x | 112.03x |
| Union of 4 variants (12 events), invalid                 |  3912 ns |  11.49x | 0.14x | 0.62x | 1.74x |   2.28x |   6.63x |         3.14x |  39.86x |  32.91x |
| 6 levels of nesting, valid                               |  1130 ns |   0.06x | 0.10x | 0.07x | 0.87x |   1.28x |  14.84x |         4.00x |  24.40x |   6.09x |
| 6 levels of nesting, invalid                             |  1417 ns |  19.27x | 0.11x | 1.68x | 2.03x |   1.75x |  25.76x |         5.04x |  81.71x |   7.05x |
| Small flat object, checks only, valid                    | 272.7 ns |   0.23x | 0.24x | 0.24x | 0.87x |   1.06x |   0.52x |         2.22x |  18.03x |  11.49x |
| Small flat object, checks only, invalid                  | 651.2 ns |   8.93x | 0.15x | 0.66x | 2.70x |   0.94x |  22.02x |         3.63x | 121.58x |   7.36x |

<!-- bench:end -->

What the tables say, for `blueprint.safeParse` of afora 0.0.11, on a GitHub runner (AMD EPYC, Linux, Bun 1.4.4, Node 22 and Node 24).

- **Against Zod 4.** On Bun, faster in all 14 cases, by 1.04x (the valid nested object) to 2.55x. On Node, faster in 10 of the 14, by 1.15x to 5.35x; Zod 4 is ahead on the list of 1,000 items (1.4x to 1.5x), on the valid flat object with nothing to transform (1.2x to 1.3x) and on the valid deep object (1.15x to 1.2x). A rejected value of a discriminated union is told by the variant it names, without TypeBox `Errors`: 1.5x to 2x faster than Zod 4.
- **Against Valibot.** On Node 24 afora is faster in all 14 cases, by 1.08x to 3.7x outside the valid union (15x); on Node 22 in 12 of them, Valibot being ahead by 4% to 9% on the invalid flat objects. On Bun it is the other way: Valibot is ahead in 10 of them, by 3% to 27% on the small objects and the invalid inputs, by 1.4x on the valid API body and by 2x on the valid nested object and the valid list; afora is ahead on the deep object (1.4x to 1.5x) and the union (2.2x to 3x).
- **Against Effect Schema, Joi and Yup.** Faster in every case: 1.7x to 5.1x Effect Schema, 4.2x to 15x Joi and 11x to 122x Yup outside the union, and up to 14x, 109x and 137x on the union.
- **Against ArkType.** Faster wherever a value is transformed or rejected, by 4.2x to 26x, because its morphs and its errors take a slower path. With nothing to transform and a valid value, ArkType is 1.9x to 2.8x faster than afora, and 2.8x on the valid union on Bun.
- **Floor.** The checkers that compile and do not transform (TypeBox, Ajv, Typia) are 3x to 7x faster than afora on a valid small object (down to 1.3x on the valid union on Node), and 5x to 50x on the larger ones. afora builds on TypeBox. On invalid input afora is 4.3x to 19x faster than TypeBox `Errors`, and Ajv stays 5x to 11x ahead.
- **Records and entities.** `Record.safeParse`, which also creates the instance, takes 1.0x to 1.9x the time of `blueprint.safeParse` on Bun and up to 3.7x on Node. `Entity.safeParse` also makes an id and the time stamps, only once the rest of the value is valid: 1.0x to 1.7x `blueprint.safeParse` on the larger objects on Bun (up to 3.1x on Node), and 2.3x to 3.9x on the small ones (up to 5.7x on Node), where making them is most of its time. `new Record(value)` throws on invalid input, which costs an exception with its trace (up to 6x `blueprint.safeParse` on Bun and 17.5x on Node); use `safeParse` where invalid input is expected.
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
