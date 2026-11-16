# Versioning

afora follows [Semantic Versioning](https://semver.org). This file says what that promises.

## Policy

Versions are `YY.minor.patch`, for example `27.1.3`, with an optional prerelease `-alpha.<n>`, `-beta.<n>` or `-rc.<n>` (see [Channels](#channels)). It is valid semver, so a range such as `^27.0.0` works and means "any 27.x.y from 27.0.0".

- **Major (`YY`)** is the year of the cycle: 27 is the 2027 cycle. It is raised at most once a year, and only a major may break the contract. Within one major, nothing in the contract breaks.
- **Minor** adds features. **Patch** fixes bugs.
- Before 27.0 (`0.0.x`), anything may break. Every breaking change is listed in `CHANGELOG.md` under the section of the next release (`## <version> — unreleased` until it is dated), marked **Breaking.**, and has a block in that release's `### Migration` section: what the code looked like before and what it looks like after, in `ts` blocks.
- From 27.0 on, a breaking change can only ship in the next year's major (28.0.0 for the 2028 cycle), and only after it was deprecated as described in [Deprecation](#deprecation). The same **Breaking.** and Migration rules apply to that major.
- `@afora/core`, `@afora/codegen` and `@afora/mcp` follow the same rules, as do the other `@afora/*` packages. A change to the `afora.json` spec counts for `@afora/codegen`.

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

It is removed only in a major, and no sooner than the next year's major.

## Supported ranges

- TypeScript >= 5.5. It is tested on 5.5, on the latest 5.x and on 7 with `bun run test:types`, in `bundler` and `nodenext` resolution.
- TypeBox `^1`. A new TypeBox major means a new afora major, which ships with the next year's major.
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
## 27.1.0 — unreleased (draft: dated when it is published)

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

## Channels

Each version is published under the npm dist-tag of its channel. Every channel installs by its tag:

| Channel     | Version            | dist-tag | From                | What it promises                                                                                   |
| ----------- | ------------------ | -------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Stable      | `27.1.0`           | `latest` | `main`              | The contract of this file.                                                                         |
| RC          | `27.1.0-rc.2`      | `rc`     | `main`              | The release as it will ship: only fixes land between two candidates.                               |
| Beta        | `27.1.0-beta.1`    | `beta`   | `main`              | The features of the next minor or major, to try out. It may still break from one beta to the next. |
| Next        | `27.1.0-alpha.<n>` | `next`   | every push to `dev` | What is on `dev` right now, published on its own. It may break at any time.                        |
| Maintenance | `27.0.4`           | `v27.0`  | `release/27.0`      | Patches of an older line, published while `dev` moves on. Only fixes.                              |

```bash
npm install @afora/core          # stable (latest)
npm install @afora/core@rc       # the release candidate
npm install @afora/core@beta     # the beta
npm install @afora/core@next     # the Next, from dev
npm install @afora/core@v27.0    # the newest patch of the 27.0 line
```

- **Order.** In semver, a prerelease comes before its release, and the channels are ordered by how stable they are: `27.1.0-alpha.9 < 27.1.0-beta.1 < 27.1.0-rc.1 < 27.1.0`. A range such as `^27.0.0` never picks a prerelease.
- **The Next.** Its version is the one of `package.json` on `dev` without its prerelease, with the minor raised when that version is already released as stable (`27.0.0` released gives `27.1.0`), then `-alpha.<n>`, where `n` is the number of the run of the workflow. It has no git tag and no GitHub release. A push to `dev` that changes nothing under `src/`, `packages/*/src/` or `package.json` publishes none.
- **Maintenance.** A patch published from `release/<YY>.<minor>` goes to `latest` when it is the newest version, and otherwise to the dist-tag of its line (`v27.0`), so `latest` never moves backwards. Its GitHub release is not marked as the latest.
- **Peer ranges.** A prerelease satisfies only a range that names a prerelease of the same `YY.minor.patch`: `@afora/core@27.1.0-rc.1` does not satisfy `>=27.0.0`. So every package of a prerelease needs `@afora/core >=<that version>`; `bun run release:version` writes it, and a stable version keeps the ranges as they are declared. Install the packages of one channel together (`npm install @afora/core@rc @afora/hono@rc`).
- **Moving a tag.** A tag that points to the wrong version is moved by hand, package by package: `npm dist-tag add @afora/core@27.1.0 latest`, or removed with `npm dist-tag rm @afora/core beta`.

## Release candidates

A stable major or minor can go through release candidates, and the first stable release, 27.0.0, does. A version such as `27.0.0-rc.1` is published to the `rc` dist-tag and marked as a prerelease on GitHub; `latest` does not move.

1. `27.0.0-rc.1` is published once the blocking issues of the 27.0 milestone are closed.
2. During the rc, only fixes land. No new exports, and no change to the contract, except to fix a blocking issue. Each fix that needs a new build ships as the next candidate (`27.0.0-rc.2`, and so on).
3. The rc stays open for at least two weeks after the last candidate.
4. It ends when no blocking issue is open. Then `27.0.0` is published to `latest`.

Later majors can use the same flow (`28.0.0-rc.1`).

## Releasing

Releases are automatic. All the `@afora/*` packages share one version. [CONTRIBUTING.md](CONTRIBUTING.md#releases) has the steps.

1. In a pull request, run `bun run release:version <version>`: it sets the version in `package.json` and in every `packages/*/package.json` (and, for a prerelease, the peer ranges on `@afora/core`), then runs `bun install` to update `bun.lock`. Date the release in `CHANGELOG.md`.
2. Merge it to `main` (or to `release/<YY>.<minor>` for a patch of an older line). `.github/workflows/release.yml` reads the version and refuses one that is not `0.0.<n>` (before 27.0) or `<YY>.<minor>.<patch>` with an optional `-alpha.<n>`, `-beta.<n>` or `-rc.<n>`, with `YY` at 27 or more. If the version has no tag, it runs CI, publishes the packages to npm with provenance under the dist-tag of its [channel](#channels), then creates the `v<version>` tag and the GitHub release.

`main` publishes stable, beta and rc versions; beta and rc are marked as prereleases. A `release/<YY>.<minor>` branch publishes only stable and rc versions of its line. The Next is published from `dev` without a pull request. A stable version behind the `latest` on npm (from `main`), packages at different versions, a peer range on `@afora/core` that does not accept the version, or a version of another line on a release branch fail the release. Running the workflow by hand with `dry-run` prints what it would publish and publishes nothing.

If a release fails halfway, run the workflow again from the Actions tab (`workflow_dispatch`). What is already on npm is skipped.

Publishing uses npm trusted publishing: each package names the workflow `release.yml` and the environment `npm` as its trusted publisher. The workflow publishes through OIDC only, with no token, so a package always goes out with provenance and its trusted publisher gets validated. npm cannot create a package through OIDC, so a new package under `packages/` is added to `DIRS` in `scripts/release-setup.sh` and the script is run once by hand: it publishes the first version from a login and registers the trusted publisher. npm marks that trusted publisher as pending until a publish through OIDC, which has to happen within its validation window (about two days): the next release after the hand-made publish validates it.
