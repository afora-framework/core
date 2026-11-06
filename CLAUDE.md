# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@afora/core` (the Standard Schema vendor is still `"afora"`) is a TypeScript library published on npm for domain modeling on TypeBox: properties → blueprints → records → entities, plus repositories, use cases, environments and layered exceptions, with Standard Schema V1 on every field. `README.md` is the user-facing spec of behavior; `CHANGELOG.md` (`## Unreleased`) records every public change and should be updated alongside features.

## Tooling

Use Bun for everything (`bun`, `bun test`, `bun check`, `bun install`, `bunx`, `Bun.file`, `Bun.$`); don't reach for Node, npm, jest/vitest, tsc --noEmit or dotenv. Bun is pinned to 1.4.4 in `mise.toml`.

```bash
bun test                                 # unit tests (bunfig.toml sets test root = src)
bun test src/core/record/record.test.ts  # one file
bun test -t "masks sensitive"            # tests matching a name
bun check                                # type check (reads tsconfig.json)
bun run lint                             # biome lint
bun run fmt                              # biome format + fix (tabs, double quotes, organized imports)
bun run build                            # dist/: bun build (ESM, node target, deps external) + tsc declarations, then scripts/add-dts-extensions.ts
bun run test:interop                     # examples/interop: real Hono, tRPC, TanStack Form tests, incl. the README quick start
bun run test:types                       # packs the package and type-checks tests/types-compat on TS 5.5, latest 5.x and 7, bundler + nodenext
bun run test:type-perf                   # tests/type-perf: per-edit type instantiations of README code (budgeted) + snapshot of hovers/completions/diagnostics, src and dist
bun run playground                       # the local playground (packages/playground) on this repo's src/
bun run test:playground                  # playground tests
bun run smoke                            # build, then run scripts/smoke.mjs on plain Node
bun run bench                            # bench/ vs TypeBox, Zod, Valibot, ArkType; results in bench/RESULTS.md
```

`packages/*` (`codegen`, `mcp`, `playground`) are workspaces with their own build and tests (`bun run build:packages`). `examples/interop`, `tests/types-compat` and `bench` have their own `package.json`/lockfiles and are excluded from the root `tsconfig.json` and `bun test`; use their scripts above.

## Runtime constraint

The library ships to Bun **and** Node >= 22 (and must load in browsers/Workers). Source under `src/` must not import `node:crypto`, `Buffer` or Bun-only APIs at module load. Runtime-specific behavior (argon2 hashing via `Bun.password` or `node:crypto` looked up lazily through `process.getBuiltinModule`, UUID v7 generation) lives in `src/std/runtime.ts` behind `configure({ hasher, idGenerator })` / `resetRuntime()`. Tests may use Bun APIs freely. `bun run smoke` is the check that the built output works on Node.

## Architecture

`src/index.ts` is the single public entry; anything exported must go through it (and usually into the README and CHANGELOG).

**`src/core/` vs `src/std/`.** `core` holds the generic machinery (builders like `blueprintBuilderOf`, `entityBuilderOf`, `recordOf`, `repositoryOf`, `useCaseOf`, `environmentOf`, exceptions, parsing, Standard Schema). `std` instantiates it with concrete properties (`Id`, `Slug`, `Email`, `Password`, time stamps, `enumOf`…) and exports the ready-made `blueprintOf` (= `blueprintBuilderOf(Std)`) and `entityOf`. **`core` must never import from `std`** — enforced by `src/core/layers.test.ts` (test and `*.sandbox.ts` files are exempt).

**The layering of concepts**, each built on the previous:
- **Property** (`core/property`): a class wrapping one value, run through `preHandle → TypeBox validation → afterHandle`; flags `optional`, `sensitive`, `unique` propagate up to records.
- **Blueprint** (`core/blueprint`): an object shape built from a context `ctx` supplied by plugins (`blueprintPluginOf`), with `listOf`, `optionalOf`, `join`, nested blueprints and record classes as fields. `optional`, `list`, `listOf`, `optionalOf`, `propertyOf` are reserved context keys.
- **Record** (`core/record`): `recordOf(blueprint, { sensitive, unique, change })` returns a class. Values live in a `WeakMap`; keys are prototype getters (so spreading a record yields nothing — use `toJSON()`). `set` is protected; `change: [...]` exposes `instance.change.<key>(value)` (a `change` namespace getter); `toJSON` masks sensitive leaves at any depth; undeclared keys are rejected at any depth; keys colliding with record members or `Object.prototype` throw `ReservedRecordKey`.
- **Entity** (`core/entity`): a record plus identity keys (`id`, `createdAt`, `updatedAt`, `deletedAt`), `destroy()`, and domain events (`eventOf`, protected `emit`, `pullEvents`, `onCreate/onUpdate/onDelete` options).
- **Repository** (`core/repository`): `repositoryOf({ entity, actions, provider, relations, environmentDependencies })` generates only the chosen async methods (`findBy<Key>` restricted to unique keys at type level and at declaration). Nested entities are stored by id reference and reloaded through `relations` in batches (`findIn`). `inMemoryProvider()` is the default `IRepositoryProvider`.
- **UseCase** (`core/use-case`): Command pattern + method injection; dependencies are UseCase classes, repositories and environments, and `execute` can override repository methods or environment variables. Repository methods calling `this.*` are routed through the use case so overrides and events propagate.
- **Environment** (`core/environment`): `environmentOf(blueprint, { source })`, coerced and validated on first `load()`.

**Cross-cutting pieces.** `core/exception`: `exceptionOf({ layer, name, message })` and `guard({ layer, source }, fn)`; each exception carries an `ExceptionLayers` value and a `trace` that grows as it crosses layers — new error types should be declared per module in an `exceptions.ts` with the right layer. `core/parse` + `core/standard`: `safeParse` and `~standard.validate` never throw for invalid input and collect every `Issue` (`code`, `path`, `source`); `Record.safeParse` goes through the class constructor. The invalid-input path is performance-sensitive (see `bench/`). `core/symbols`: `Kind`, `State`, `Demo` symbols brand values so blueprints, lists and records are distinguished by brand, not by shape.

**Type-level work is a large part of the code.** Inference of inputs/outputs, unique keys (`MarkedUniqueKey`, literal `options.unique`), the `change.<key>` namespace members and generated `findBy<Key>` method names, etc. live in each module's `types/*.interface.ts`. Changes to public types should be checked with `bun run test:types`, not just `bun check`, and with `bun run test:type-perf`: it keeps the editor cost per edit under budget and the writing experience (hovers, completions, error messages) unchanged unless its snapshot is updated on purpose (`-u`).

## Conventions

- File layout per module: implementation, `exceptions.ts`, `types/*.interface.ts`, colocated `*.test.ts`, and optional `*.sandbox.ts` scratch scripts (run with `bun <file>`; excluded from the build and the layering test).
- Conventional commits with optional scope: `feat(repository): …`, `fix(use-case): …`, `chore: …`.
