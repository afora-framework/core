# Versioning

afora follows [Semantic Versioning](https://semver.org). This file says what that promises.

## Policy

- Before 1.0 (`0.0.x`), anything may break. Every breaking change is listed in `CHANGELOG.md` under `## Unreleased`, and later under its release, prefixed with "Breaking:".
- From 1.0 on, a breaking change only happens in a major version. A major is not planned. After 1.0, releases are fixes and quality-of-life improvements.
- A minor adds features. A patch fixes bugs.
- `@afora/core`, `@afora/codegen` and `@afora/mcp` follow the same rules. A change to the `afora.json` spec counts for `@afora/codegen`.

## What is the contract

- The runtime behavior documented in `README.md` and the docs.
- Every exported value and type of `@afora/core`, from `src/index.ts` and its subpaths, except what is listed below as not the contract.
- The format of serializable descriptors: record plugin descriptors (`kind: "record-plugin"`), the output of `app.describe()`, and operation descriptors when they exist.
- Standard Schema behavior: the vendor is `"afora"`, `~standard.validate` never throws for invalid input, and each issue has a `code`, a `path` and a `source`. The `code` values are part of the contract.
- The `afora.json` spec (`version: 1`) and its JSON Schema, `afora.schema.json`. The spec only receives additions.
- The lists of reserved keys, such as `RESERVED_RECORD_KEYS`. They do not grow: new framework members are only added under symbol keys, so a key that is valid today stays valid.

## What is not the contract

- The text of error messages. Match on the exception class, its `layer` or an issue `code`.
- Types marked `@internal`.
- Anything under an `experimental` subpath (`@afora/core/experimental`). It may change in any release.
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

- `bun run test:api` snapshots the public surface (exports, signatures and `afora.schema.json`). A change to the snapshot has to be intended and shows up in review.
- `bun run test:types` type-checks the packed package on the supported TypeScript versions.
- `bun run test:type-perf` budgets the editor cost and snapshots hovers, completions and diagnostics.
- `CHANGELOG.md` lists every public change under `## Unreleased`, and a breaking one is marked "Breaking:".
