---
name: rc-hunt
description: Runs a vulnerability and bug hunt on the latest afora release candidate (or a given tag) — scopes the tag, runs the baseline checks, fans out afora-hunter agents per attack surface, verifies each finding with afora-verifier, fixes the confirmed ones with SEC-NN tests, files private draft advisories, and prepares the next rc patch (on release/<YY>.<minor> when the line has its branch, else with a dev → main release PR). Trigger with /rc-hunt [tag] [--surfaces a,b] [--no-fix] [--no-release].
---

# /rc-hunt: hunt the latest release candidate

You conduct an authorized security and bug hunt on afora's own code. The goal is a release candidate that holds: every finding is reproduced, verified, fixed with a test, recorded privately and shipped as the next candidate.

Arguments (all optional): a tag (`v27.0.0-rc.4`), `--surfaces <keys>` (comma list of the surface keys below), `--no-fix` (stop after the report), `--no-release` (skip phase 8).

## Disclosure rules (read first)

`afora-framework/core` is a **public** repository. A branch, a commit message, a PR or a CHANGELOG line can disclose a vulnerability before its fix is out.

- Findings and PoCs live only in `docs/plans/security/` (ignored by `.gitignore`), in `*.sandbox.ts` files (ignored) and in private draft advisories. Never in an issue, a public PR body or a commit message.
- Nothing is pushed before phase 7, and nothing in phase 7 or 8 happens without the user's explicit go-ahead: each push, PR, advisory or merge is an outward-facing action. Ask once per batch, naming what goes out.
- Commit messages, PR titles and bodies, and CHANGELOG entries describe the fix neutrally ("mask nested sensitive values in variant outputs"), with no reproduction and no attack recipe. Advisory ids (GHSA) are referenced only once the advisory is published.
- For a **critical** finding, offer the private route before any push: the advisory's temporary private fork ("Start a temporary private fork" on the draft advisory), where the fix is reviewed and merged privately.
- The release candidate rule (`VERSIONING.md`, "Release candidates"): only fixes land. No new export, no change to the contract. If a fix needs one, stop and ask.

## Surfaces

| key | targets | what to attack |
|---|---|---|
| `validation` | `src/core/{parse,record,blueprint,property,standard,schema}`, `src/std/properties` | undeclared keys at any depth, reserved keys, `__proto__`/`constructor`/`prototype`, bypass through `variantOf`/`listOf`/`optionalOf`/nested records, ReDoS in property regexes, depth and size limits, coercion that changes meaning, `safeParse` or `~standard.validate` throwing |
| `secrets` | `src/core/{record,output,exception,logger,tracing,application}`, `packages/otel` | a `sensitive` value leaking through `toJSON`, outputs, issues, exception messages and traces, logs, spans, `JSON.stringify`, `structuredClone`, `util.inspect`, nested or listed records, variants |
| `auth` | `src/core/auth`, `src/std/properties/password.ts`, `src/std/runtime.ts`, `src/std/properties/identity.ts` | JWT `alg` confusion and `none`, signature and claim checks (`exp`, `nbf`, `aud`, `iss`), non-constant-time comparisons, hasher fallback and parameters, predictable ids |
| `http` | `packages/{hono,express,fastify,elysia,ws}`, `src/std/properties/file.ts`, `src/core/openapi` | body and upload limits, webhook signatures and replay, status codes and problem bodies leaking internals, header handling, the cost of the invalid-input path (DoS), WebSocket message handling |
| `codegen` | `packages/{codegen,mcp}` | everything in the trust model of `SECURITY.md`: path escape (symlink, `..`, `%2e`, `\`, `?`, `#`, `extends`, `output.dir`), runtime builtins, overwrite without banner, subprocess and `tsc` invocation, error reports carrying source |
| `data` | `packages/{drizzle,dynamodb}`, `src/core/{repository,environment,command,use-case}`, `.github/workflows`, `package.json` and lockfiles | injection into queries and expressions, `findIn` batches, unique keys that do not hold, use-case overrides crossing boundaries, environment values in errors, workflow permissions, `pull_request_target`, OIDC publish, unpinned actions, dependency advisories |

## Phase 1: scope

1. `git fetch origin --tags`. Target = the given tag, else `git tag --sort=-v:refname --list 'v*-rc.*' | head -1`. Previous = the tag before it in the same list (or the latest stable).
2. `git worktree add .claude/worktrees/hunt-<tag> <tag>` (detached, ignored), then `bun install` inside it. All hunting happens in that worktree.
3. `git diff --stat <previous>..<tag>`: files changed since the previous candidate are hunted first.
4. Read `SECURITY.md` (scope, trust model, "Out of scope") and `VERSIONING.md` (what the contract is).
5. Collect the SEC ids already covered: `grep -rhoE 'SEC-[0-9]+' src packages/*/tests | sort -t- -k2 -n -u`. The next id is one above the highest (also check `dev`, which may hold newer ones).
6. Look for a previous report in `docs/plans/security/` and carry over what is still open.

## Phase 2: baseline

In the tag worktree, run and record each result: `bun test`, `bun check`, `bun run lint`, `bun run smoke`, the package tests (`bun run test:codegen`, `test:mcp`, `test:hono`, `test:fastify`, `test:express`, `test:elysia`, `test:ws`, `test:drizzle`, `test:dynamodb`, `test:otel`) and a dependency audit (`bun audit` if the installed Bun has it, else `bunx npm audit --omit=dev` from a copy of the lockfile state; note when neither runs). A failure here is a finding of kind `bug`.

## Phase 3: hunt

Send one message with one `Agent` call per selected surface (`subagent_type: "afora-hunter"`), all in parallel. Each prompt carries:

- the surface key, its targets and attack list from the table;
- the absolute path of the tag worktree;
- the SEC ids already covered and the test files that hold them (so the hunter attacks around them, not the same thing);
- the changed files of that surface since the previous tag;
- the scratchpad directory for anything that is not a `*.sandbox.ts`.

Keep the scope narrow; six hunters is the default.

## Phase 4: verify

For each finding, start one `Agent` with `subagent_type: "afora-verifier"`. Give it the code locations, the PoC and the command to run it, and the tag worktree path, **not** the hunter's reasoning or severity. Independent findings are verified in parallel. Keep CONFIRMED and PLAUSIBLE; list REFUTED with its reason. Merge duplicates across surfaces.

Then classify each CONFIRMED finding as **blocking** or **not blocking** by [What blocks a release](../../../VERSIONING.md#what-blocks-a-release): blocking only when its fix is a breaking change of the contract, it is a vulnerability of high or critical severity with no documented mitigation, or it loses or corrupts stored data. Everything else is not blocking, however many there are.

For a PLAUSIBLE finding, try once yourself to turn it into a running PoC; if you cannot, it stays PLAUSIBLE in the report and is not fixed.

## Phase 5: fix (skipped with `--no-fix`)

For each CONFIRMED finding, blocking ones first, then most severe first:

1. Check that it still reproduces on `origin/dev` (run the PoC there). If `dev` already fixed it, note the commit and skip to the next.
2. `git worktree add ../afora-sec-<slug> -b sec/<slug> origin/dev` (`fix/<slug>` for a plain bug), then `bun install`.
3. Write the test first, in the module's `security.test.ts` (or `<file>.security.test.ts`, or `packages/<pkg>/tests/security.test.ts`), following the existing style: `describe("SEC-NN: <neutral title>", …)` and tests named `SEC-NN: …`. Run it and see it fail.
4. Fix it in the smallest way that holds, in the layer where the guarantee belongs (`core` never imports from `std`; `src/` loads on Bun, Node 22 and browsers).
5. Run `bun test`, `bun check`, `bun run lint`, `bun run fmt`, `bun run test:api` (never `-u`: a changed public surface is a stop-and-ask), the tests of the touched package, and `bun run test:type-perf` when types changed.
6. Add the entry under `## Unreleased` in `CHANGELOG.md` (`### Security` or `### Fixed`), written neutrally. If behavior described in `docs/*.md` changes, update that page.
7. Commit `fix(<scope>): <neutral summary>` with the attribution lines of the session. Do not push.

## Phase 6: record

1. Write `docs/plans/security/<YYYY-MM-DD>-<tag>.md`: target and previous tag, baseline results, a table of findings (id, surface, kind, severity, verdict, blocking or not, `file:line`, fix branch, advisory), each finding with conditions, impact and PoC, the REFUTED ones with their reason, and the surfaces hunted with no finding. Check it is ignored: `git check-ignore -q docs/plans/security/<file>`.
2. For each CONFIRMED vulnerability of severity medium or higher, ask the user, then create a draft advisory (drafts are private):

   ```bash
   gh api -X POST repos/afora-framework/core/security-advisories --input advisory.json
   ```

   with `summary`, `description` (impact, conditions, reproduction), `severity` (`low|medium|high|critical`), `cwe_ids`, and `vulnerabilities: [{ "package": { "ecosystem": "npm", "name": "@afora/<pkg>" }, "vulnerable_version_range": "<= <version>", "patched_versions": null }]`. Write `advisory.json` in the scratchpad. Put the advisory URL in the report.

## Phase 7: integrate into `dev`

Show the user the list of branches to push and the neutral PR titles, and wait for the go-ahead (or the choice of the private fork for a given advisory). When the line of the rc has its branch (`git ls-remote --heads origin release/<YY>.<minor>`), a blocking fix is branched from and opened against `release/<YY>.<minor>` instead, and carried to `dev` in a second pull request (`git cherry-pick -x`, without its CHANGELOG entry); a fix that does not block goes to `dev` only. Then, for each branch: `git push -u origin <branch>`, `gh pr create --base <dev or release/<YY>.<minor>>` with a neutral body ending with the PR attribution line, and `gh pr checks <n> --watch`. Merging is the user's call: offer `! gh pr merge <n> --merge`, or merge only on their explicit approval.

## Phase 8: prepare the rc patch and open `dev` → `main` (skipped with `--no-release` or when no blocking fix was merged)

Only a blocking fix makes a new candidate. When every fix merged is not blocking, skip this phase: the fixes stay in `dev` for the first patch (put their issues in the `27.0.1` milestone), the rc is not extended, and the summary says so.

The `prepare-release.yml` workflow has no secrets; prepare locally. **When the line has its branch** (`release/27.0`, see [VERSIONING.md](../../../VERSIONING.md#a-release-candidate-on-its-own-branch)), use it as the base instead of `dev` in steps 1, 2 and 5 (`BRANCH=release/27.0 bun scripts/release-channel.ts prepare --channel rc`, `gh pr create --base release/27.0`) and skip step 6: merging the bump into `release/27.0` publishes, so the merge in step 5 is the user's, as in step 7. After the publish, copy the dated section into the CHANGELOG of `dev`, below `## Unreleased`, in a pull request against `dev`.

1. `git fetch origin` and `git worktree add ../afora-release-<v> -b chore/release-<v> origin/dev`, then `bun install`.
2. `BRANCH=dev bun scripts/release-channel.ts prepare --channel rc` gives the next candidate (`27.0.0-rc.<n+1>`), dates the changelogs and sets the version (and peer ranges) in every `package.json`. Read `<v>` from `package.json` afterwards.
3. Write the lead of the `<v>` section in `CHANGELOG.md` in the style of the previous candidates ("The fifth candidate of 27.0.0: …. Nothing in the public API changes."), still neutral. Check the section with `bun scripts/release-channel.ts section <v>`.
4. Run `bun test`, `bun check`, `bun run test:api`, `bun run docs:links`.
5. Ask the user, then commit `chore: release <v>`, push, `gh pr create --base dev --title "chore: release <v>"`, and wait for its checks and merge.
6. Once it is in `dev`: `gh pr create --base main --head dev --title "Release <v>"` with the body = the `<v>` section of `CHANGELOG.md` plus the attribution line (as in earlier release PRs).
7. **Do not merge it.** Merging publishes to npm. Hand the user `! gh pr merge <n> --merge` and remind them that the `npm` environment waits for their approval. Known traps: a release run on `main` can sit `pending` behind a bench job (the `bench-results` concurrency group); the bench results PR is opened by `GITHUB_TOKEN` and needs a close and reopen to get CI; the npm packument can lag for minutes after publish.
8. After the publish (when the user says so, or in a later session): update each draft advisory with `patched_versions: "<v>"` (`gh api -X PATCH repos/afora-framework/core/security-advisories/<ghsa>`) and ask whether to publish it. Once published, a follow-up may reference the GHSA in the CHANGELOG.

## Phase 9: close

Remove the tag worktree (`git worktree remove .claude/worktrees/hunt-<tag>`) and the fix worktrees whose branches were merged. End with a short summary: target, counts by verdict and severity, report path (absolute), advisories, PRs into `dev`, the `Release <v>` PR and the merge command, and anything left PLAUSIBLE or open.
