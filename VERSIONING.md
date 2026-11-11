# Versioning

afora follows [Semantic Versioning](https://semver.org). This file says what that promises.

## Policy

- Before 1.0 (`0.0.x`), anything may break. Every breaking change is listed in `CHANGELOG.md` under the section of the next release (`## <version> — unreleased` until it is dated), marked **Breaking.**, and has a block in that release's `### Migration` section: what the code looked like before and what it looks like after, in `ts` blocks.
- From 1.0 on, a breaking change only happens in a major version. A major is not planned. After 1.0, releases are fixes and quality-of-life improvements.
- A minor adds features. A patch fixes bugs.
- `@afora/core`, `@afora/codegen` and `@afora/mcp` follow the same rules. A change to the `afora.json` spec counts for `@afora/codegen`.

## What is the contract

- The runtime behavior documented in `README.md` and the docs.
- Every exported value and type of these entries, except what is listed below as not the contract:
  - `@afora/core` (`src/index.ts`): the stable API, what application code imports;
  - `@afora/core/adapters` (`src/adapters.ts`): the plumbing for sinks, providers and code generators, such as `IRepositoryProvider`, `sinkOf`, `problemOf` and the `app.describe()` types;
  - `@afora/core/testing` (`src/testing/index.ts`): `providerContract` and `memoryPublisher`.

  [docs/api-tiers.md](docs/api-tiers.md) lists the tier of every export.
- The format of serializable descriptors: record plugin descriptors (`kind: "record-plugin"`), the output of `app.describe()`, and operation descriptors when they exist.
- Standard Schema behavior: the vendor is `"afora"`, `~standard.validate` never throws for invalid input, and each issue has a `code`, a `path` and a `source`. The `code` values are part of the contract.
- The `afora.json` spec (`version: 1`) and its JSON Schema, `afora.schema.json`. The spec only receives additions.
- The lists of reserved keys, such as `RESERVED_RECORD_KEYS` (in `@afora/core/adapters`). They do not grow: new framework members are only added under symbol keys, so a key that is valid today stays valid.

## What is not the contract

- The text of error messages. Match on the exception class, its `layer` or an issue `code`.
- Types marked `@internal`.
- Anything under the `experimental` subpath (`@afora/core/experimental`). It may change or be removed in any release; it is promoted to `@afora/core` or `@afora/core/adapters` when it settles.
- Internal modules of the package (`dist/core/...`, `dist/std/...`): only the entries above are exported, and what they do not export is not the API.
- Performance numbers, such as those in `bench/RESULTS.md`.
- The exact shape of hovers, completions and diagnostics in an editor. They are tracked by `bun run test:type-perf`, and a change to them is reviewed, but it is not breaking.
- Private and protected members and any internal that the docs do not describe.

## Additive changes

These ship in a minor:

- A new export, function, class or type.
- A new optional option, field or parameter.
- A new optional method on an interface that users implement, such as `IRepositoryProvider`.
- A new optional field in a descriptor or in the spec.
- A new issue `code`. It is additive, and it is documented in the README and the CHANGELOG. Code that matches on `code` should have a fallback for unknown values.
- A new exception class, in a layer that already exists.
- A new member under a symbol key.

## Breaking changes

These ship in a major:

- Removing or renaming anything in the contract.
- Narrowing the input a function, option or spec accepts.
- Widening a returned or exported type, for example a value that can now also be `undefined`.
- A new required member of an interface that users implement, such as `IRepositoryProvider`.
- Changing a default.
- Removing or renaming an issue `code`, or changing when it is raised.
- Changing the meaning of a field in a descriptor or in the spec, or making an optional one required.
- Adding a key to a reserved list.
- Dropping support for a version listed under "Supported ranges".

A fix that makes the code match what the docs already said is not breaking, even if some code relied on the bug. It is listed in the CHANGELOG.

## Deprecation

Something in the contract is not removed at once. First it is deprecated:

1. Its JSDoc gets `@deprecated`, with what to use instead.
2. It logs a warning once per process, with `console.warn`.
3. The CHANGELOG lists it under "Deprecated".

It is removed only in a major.

## Supported ranges

- TypeScript >= 5.5. It is tested on 5.5, on the latest 5.x and on 7 with `bun run test:types`, in `bundler` and `nodenext` resolution.
- TypeBox `^1`. A new TypeBox major means a new afora major.
- Bun >= 1.4.4 and Node >= 22.
- Browsers and Workers must load the core: `src/` imports no `node:crypto`, `Buffer` or Bun-only API at load.

Dropping a version of TypeScript, Bun or Node is breaking, except when that version is no longer supported by its own maintainers.

## How it is enforced

- `bun run test:api` snapshots the public surface of each entry (exports, signatures and `afora.schema.json`). A change to the snapshot has to be intended and shows up in review.
- `bun run test:types` type-checks the packed package on the supported TypeScript versions.
- `bun run test:type-perf` budgets the editor cost and snapshots hovers, completions and diagnostics.
- `CHANGELOG.md` lists every public change under the section of the next release; a breaking one is marked **Breaking.** and has a Migration block (before and after).

## Changelog template

Each release in `CHANGELOG.md` has these sections, in this order, each only when it has entries:

````md
## 0.1.0 — unreleased (draft: dated when it is published)

### Changed

- **Breaking.** What changed, and what to use instead. See Migration below.

### Added

### Deprecated

### Fixed

### Migration

**Short title of the change.** Before:

```ts
// the code that worked in the previous release
```

After:

```ts
// the same code for this release
```
````

Every **Breaking.** entry, of values, types or behavior, has its block under Migration.

## Releasing

Releases are automatic. All the `@afora/*` packages share one version.

1. In a pull request, set the same new `version` in `package.json` and in every `packages/*/package.json`, run `bun install` to update `bun.lock`, and date the release in `CHANGELOG.md`.
2. Merge it to `main`. `.github/workflows/release.yml` sees a version without a tag, runs CI, publishes the packages to npm with provenance, then creates the `v<version>` tag and the GitHub release.

A version with a `-` (such as `1.0.0-rc.1`) is published under the `next` dist-tag and marked as a prerelease. The others go to `latest`. A version behind the `latest` on npm, or packages at different versions, fail the release.

If a release fails halfway, run the workflow again from the Actions tab (`workflow_dispatch`). What is already on npm is skipped.

Publishing uses npm trusted publishing: each package names the workflow `release.yml` and the environment `npm` as its trusted publisher. A package that is not on npm yet needs its first publish to go through a temporary `NPM_TOKEN` secret in that environment.
