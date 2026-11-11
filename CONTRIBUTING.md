# Contributing to afora

Thanks for helping. This page covers the setup, what a change has to pass, and how a release happens. Questions and ideas go to [Discussions](https://github.com/afora-framework/core/discussions); a security issue goes through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

afora uses [Bun](https://bun.sh) for everything (install, tests, type check, build). The version is pinned in `mise.toml`.

```bash
git clone https://github.com/afora-framework/core.git
cd core
bun install        # also installs the Husky hooks
bun test           # unit tests
bun check          # type check
```

The library ships to Bun **and** Node >= 22 and must load in browsers and Workers, so source under `src/` does not import `node:crypto`, `Buffer` or Bun-only APIs at module load (runtime-specific code lives in `src/std/runtime.ts`). Tests may use Bun APIs freely.

## Where things live

- `src/core/`: the generic machinery (builders, records, entities, repositories, use cases, exceptions, parsing). It never imports from `src/std/`, which `src/core/layers.test.ts` enforces.
- `src/std/`: concrete properties (`Id`, `Email`, `Password`…), `blueprintOf`, `entityOf` and the standard use cases.
- `src/index.ts`, `src/adapters.ts`, `src/experimental.ts` and `src/testing/index.ts`: the four public entry points (`@afora/core`, `/adapters`, `/experimental`, `/testing`; see [docs/api-tiers.md](docs/api-tiers.md)). Anything exported goes through one of them.
- `docs/`: the spec of behavior, one file per concept ([index](docs/README.md)).
- `packages/*`: `@afora/codegen`, `@afora/mcp`, `@afora/hono`, `@afora/fastify`, `@afora/express`, `@afora/elysia`, `@afora/ws`, `@afora/drizzle`, `@afora/dynamodb` and `@afora/otel`, each with its own build and tests.
- `examples/`, `tests/types-compat`, `tests/type-perf`, `bench/`: interop, type compatibility, editor performance and benchmarks, each with its own scripts.

## Making a change

1. Open an issue first for anything larger than a fix, so the design can be discussed.
2. Branch from `dev` and open the pull request against `dev`.
3. Keep behavior and docs together: a change in behavior updates the matching `docs/*.md`, and a public change gets an entry under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md).
4. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

Commits follow [Conventional Commits](https://www.conventionalcommits.org) with an optional scope (`feat(repository): …`, `fix(use-case): …`, `docs: …`), checked by commitlint in the `commit-msg` hook. The `pre-commit` hook runs Biome and Knip.

## JSDoc

The JSDoc of an export is what a user reads in the editor, so it is part of the public contract.

- **Every export of the four entry points has JSDoc.** `tests/api-surface/jsdoc.test.ts` fails when one does not, so a new export is documented in the same pull request.
- **Prose first.** Open with a noun phrase that says what the thing is ("A record of `blueprint`: ..."), then how it behaves, in one short paragraph; inline code for names. Read the implementation and the matching `docs/*.md` before writing, and never describe behavior the code does not have. See `recordOf` and `repositoryOf` for the tone.
- **`@example` on the main builders and entry points** (`propertyOf`, `blueprintOf`, `recordOf`, `entityOf`, `eventOf`, `repositoryOf`, `useCaseOf`, `environmentOf`, `exceptionOf`, `guard`, `applicationOf`). An example is a short (about 15 lines), self-contained TypeScript module in a `ts` fence that imports from `"@afora/core"` (or `"@afora/core/adapters"`...), and it agrees with `docs/` and the README. Examples are type-checked against `dist/` by the tests, so a stale one fails the build; a types-only export does not need one.
- **`@throws {@link ExceptionName} when ...`** on a function or constructor that throws on declaration or use (`ReservedRecordKey`, `ReservedBlueprintKey`, `UseCaseAlreadyExecuted`...), one tag per exception, naming the condition. Verify it in the code.
- **`@default value`** on an optional setting that has a default, with the value as the code uses it, instead of "by default" in the prose.
- **`{@link Name}`** where a doc mentions another export, so the editor links to it.
- A change to a doc shows in the hovers, so `bun run test:type-perf` reports it: update its snapshot with `-u` only when the diff is the documentation you wrote.

## Checks

CI runs all of these on every push and pull request; run the ones your change touches before pushing.

```bash
bun run lint            # Biome lint
bun run fmt             # Biome format + fix (tabs, double quotes, organized imports)
bun run knip            # unused files, exports and dependencies
bun test                # unit tests
bun check               # type check
bun run test:api        # snapshot of the public surface and of afora.schema.json
bun run test:types      # the packed package on TypeScript 5.5, latest 5.x and 7
bun run test:type-perf  # editor cost per edit, hovers, completions and errors
bun run test:interop    # Hono, tRPC, TanStack Form and the README quick start
bun run docs:links      # every relative link and anchor in the docs resolves
bun run smoke           # the build, run on plain Node
```

- A change to public types runs `test:types` and `test:type-perf`, not only `bun check`.
- A snapshot (`test:api`, `test:type-perf`) is updated with `-u` only on purpose, and the pull request says why.
- The quick start in `README.md` must stay equal to `examples/interop/quickstart.ts` and `quickstart.afora.json`; `test:interop` checks it.
- Parsing and validation are performance-sensitive, valid and invalid input alike. `bun run bench:guard` (the `bench` job in CI) times `blueprint.safeParse` against Zod 4 `safeParse` on the fourteen cases of `bench/` (seven scenarios, valid and invalid input) and fails when afora is over the limit of a case; it compares a ratio measured in one process, so it does not depend on the machine. A case over its limit is timed twice more before the guard fails, to rule out the noise of a shared runner. Run it when you touch `src/core/parse`, `src/core/property`, `src/core/schema` or the constructor of a record. When it fails, find what the change costs; a limit (`bench/guard.limits.ts`, 1.15x unless stated) is only raised for a cost that is wanted, with the reason next to it, and the pull request says why. `bun run bench` runs every contender on Bun and Node and rewrites `bench/results/latest.json` and `bench/RESULTS.md` (about half an hour; `bun run bench -- --only flat,union` runs some scenarios and writes nothing); run it on an idle machine, when a change moves them; the table and the chart of the Performance section of `README.md` are generated with it (`bun run bench:check` fails when they are edited by hand), and the prose under them is updated by hand. A pull request is also timed against its base and fails when `blueprint.safeParse` takes more than 1.1x its base on a case (`bun run bench -- --compare <checkout of the base>` runs it locally). A new scenario or library follows [bench/README.md](bench/README.md); the Typia validators are regenerated with `bun run typia` in `bench/`, which needs Go.

## Reviewing a change

Every pull request into `dev` or `main` is reviewed by a maintainer other than its author before it is merged. (While the project has only one maintainer, the author merges after the checks pass.)

The reviewer checks that:

- CI is green.
- The docs and the CHANGELOG are updated: a change in behavior updates the matching `docs/*.md`, and a public change has an entry under the section of the next release.
- A snapshot update (`test:api`, `test:type-perf`) is intended and the pull request says why.
- A breaking change is marked **Breaking.** and has a Migration block (before and after), as [VERSIONING.md](VERSIONING.md) asks.
- The bench guard passes, or a raised limit has its reason next to it.

On the pull request, choose "Review changes". Choose "Approve" when the checks above hold, or "Request changes" with what has to change; the author pushes the fix and asks for another look. After the approval, the author merges.

## Releases

Versions follow [VERSIONING.md](VERSIONING.md). Any maintainer can make a release, not only the author of the changes. All the `@afora/*` packages share one version.

1. From `dev`, open a release pull request against `main`. In it, set the same new `version` in `package.json` and in every `packages/*/package.json`, run `bun install` to update `bun.lock`, and replace `unreleased (draft: ...)` with the date in the heading of the `CHANGELOG.md` section.
2. Have it reviewed as described above and merge `dev` into `main`.
3. `.github/workflows/release.yml` runs on the push to `main`. It reads the version and fails when it is outside the scheme, when a package is at another version, or when it is behind the `latest` on npm. If the version has no tag yet, it runs CI, publishes every package to npm, then creates the `v<version>` tag and the GitHub release. A version with `-rc.<n>` goes to the `next` dist-tag and is marked as a prerelease. The benchmark job runs last.
4. If a release fails halfway, run the workflow again from the Actions tab (`workflow_dispatch`, on `main`). What is already on npm is skipped.

Publishing uses npm trusted publishing (OIDC), with no token, and runs in the GitHub environment `npm`. A maintainer who releases needs access to that environment; the owner of the repository grants it in the repository settings, under Environments. Without access, the publish job waits for or fails on the environment.

A new package under `packages/` is added to `DIRS` in `scripts/release-setup.sh`, and the script is run once by hand (`bash scripts/release-setup.sh`), since npm cannot create a package through OIDC.

The first stable release goes through release candidates; see [Release candidates](VERSIONING.md#release-candidates).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
