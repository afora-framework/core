# Command line

Two packages install a command: `@afora/codegen` gives `afora-codegen`, and `@afora/mcp` gives `afora-mcp`. Both are published as ESM with a `node` shebang and run on Node >= 22 or Bun >= 1.4.4. Each has peer dependencies on `@afora/core` and TypeBox, so install them in the project:

```bash
bun add @afora/core typebox
bun add -d @afora/codegen           # afora-codegen
bun add -d @afora/mcp               # afora-mcp
bunx afora-codegen --help           # or: npx afora-codegen --help
```

This page is the reference of what each command takes, prints and returns. For the format of the spec, see [afora.json](afora-json.md), and for each issue code, the [troubleshooting](troubleshooting.md#afora-codegen-and-afora-mcp) table.

**Exit codes of `afora-codegen`.** `0` for success, `1` for a failure (an invalid spec, a refused file, a lock that is stale, a file that cannot be loaded), `2` for a command used wrongly (an unknown command, `extract` without `#Export`, `schema` without `lock` or `check`). With no command, or `--help` or `-h`, it prints the usage and exits `0`. The usage always goes to standard error.

## afora-codegen

```text
afora-codegen check [afora.json] [--providers module] [--stages module] [--policies module]
afora-codegen generate [afora.json] [--out dir] [--providers module] [--stages module] [--policies module]
afora-codegen extract <file.ts>#App [--output-dir dir] [--import key=./file.ts#name]...
afora-codegen schema lock <file.ts>#App [--out afora.lock.json] [--force]
afora-codegen schema check <file.ts>#App [--lock afora.lock.json]
```

Problems print one per line to standard error as `path: [code] message`, then `N problems.` (the path is `(root)` for the spec itself).

### Catalog flags

`--providers`, `--stages` and `--policies` give codegen the names a spec may use beyond the built-in ones. Each takes the path of a module (relative to the current directory) that exports `providers`, `stages` or `policies`, or a default export, as an array:

| Flag          | Exports                                       | Built in            |
| ------------- | --------------------------------------------- | ------------------- |
| `--providers` | `providers`: `{ name, module, export }[]`     | `inMemory`          |
| `--stages`    | `stages`: `{ name, module, export, kind? }[]` | `select`, `openapi` |
| `--policies`  | `policies`: `{ name, module, export }[]`      | `publishEvents`     |

`module` is a package or a path relative to the output directory, and `export` is the factory. A module that does not export an array fails with `<path> must export <key> (or a default export): an array of { name, module, export }.` See [afora.json](afora-json.md#catalogs-providers-stages-and-event-policies).

### afora-codegen check

Validates the spec and writes nothing.

- **Argument.** The spec file; `afora.json` in the current directory when left out. A spec that `extends` others is resolved first.
- **Flags.** The three catalog flags.
- **Output.** `<absolute path> is valid.` and exit `0`; or the issues and exit `1`. A file that cannot be read or parsed prints `Cannot read <path>: ...` and exits `1`.

```bash
bunx afora-codegen check
bunx afora-codegen check specs/blog.afora.json --stages ./stages.ts
```

### afora-codegen generate

Validates the spec like `check`, then writes the TypeScript.

- **Argument.** The spec file, `afora.json` by default.
- **`--out dir`.** Where to write, replacing `output.dir` of the spec. Both are relative to the directory of the spec file.
- **Catalog flags.** As in `check`.
- **Output.** One line per file, `wrote <path>` or `removed <path>`, or `Everything is up to date.` when nothing changed. Exit `0`.
- **What it touches.** It overwrites and removes only files that start with the generated banner, so rerunning it is safe and a file you wrote by hand is never replaced. A file that exists without the banner, is not a regular file, is a symbolic link, or would resolve outside the project is refused: nothing is written, each is printed as `refused <path>: <reason>`, and the exit code is `1`.

```bash
bunx afora-codegen generate --stages ./stages.ts
bunx afora-codegen generate afora.json --out src/domain
```

### afora-codegen extract

Prints the `afora.json` of an application written in TypeScript.

- **Argument.** `<file.ts>#ExportName`: the file and the name of an exported application (an object with `describe()`). Without `#` it exits `2`; a file that does not export one prints `<path> does not export an application named <Name>.` and exits `1`.
- **`--output-dir dir`.** Sets `output.dir` in the printed spec.
- **`--import key=./file.ts#name`.** Repeatable. Maps something a spec cannot describe to the export it is imported from: a provider made without `providerOf` (`provider`, `repositories.<Name>.provider`, `providers.<key>`), a hand-written use case (`useCases.<Name>`), the `run` function of a steps use case (`useCases.<Name>.run.<name>`), a command handler (`commands.<Name>.events`, `commands.<Name>.onEventError`), a publisher (`publishers.<key>`), a stage written by hand (`outputs.<Name>.pipe.<index>`) or an upgrade step (`entities.<Name>.upgrade.<n>`). A value that is not `key=value` is an error.
- **Output.** The spec as JSON on standard output (tab indented), so redirect it: `> afora.json`.
- **Runtime.** It imports your file: run it with Bun, or Node >= 22.18 (type stripping on by default) for TypeScript files.

```bash
bunx afora-codegen extract src/app.ts#App > afora.json
bunx afora-codegen extract src/app.ts#App --import provider=./db.ts#provider > afora.json
```

### afora-codegen schema

Writes and checks the [schema lock](schema-evolution.md#the-lock), `afora.lock.json`, which records the shape of each entity of an application.

```bash
bunx afora-codegen schema lock src/app.ts#App            # write afora.lock.json; commit it
bunx afora-codegen schema check src/app.ts#App           # in CI
```

**`schema lock <file.ts>#App`**

- **`--out file`.** The lock to write. `afora.lock.json` in the current directory by default.
- **`--force`.** Writes even when a change needs a declaration the code lacks.
- **Behavior.** It compares the application with the lock that is there. When a change needs a `fill`, `renamedFrom`, `previousNames` or `upgrade` step that the code does not declare (or an entity needs a higher `schemaVersion`), it prints each change, the stubs to add to the options of `entityOf`, and `Not written: declare what the changes need, or pass --force.`, and exits `1`. Otherwise it writes the file, prints `wrote <path>` and exits `0`.

**`schema check <file.ts>#App`**

- **`--lock file`.** The lock to compare with. `afora.lock.json` in the current directory by default.
- **Behavior.** Exits `0` and prints `<path> is up to date.` when the lock matches. It exits `1` when the lock does not exist (`<path> does not exist: write it with afora-codegen schema lock.`), when it is stale (each change is printed, then `<path> is stale: N changes; update it with afora-codegen schema lock.`), when a declared change is not satisfied, when an entity of the lock is gone without `previousNames`, or when a `schemaVersion` went down. For each missing step it prints a stub to paste into `entityOf`.

`app.start({ lock })` runs the same check in the process, and refuses to start with `SchemaLockMismatch`. See [Schema evolution](schema-evolution.md).

## afora-mcp

An [MCP](https://modelcontextprotocol.io) server on standard input and output. It does not take a subcommand: an MCP client starts it and speaks to it.

```text
afora-mcp [--project <dir>] [--app <file.ts#Export>] [--providers <module>] [--stages <module>] [--policies <module>]
```

| Flag           | Meaning                                                                                                                                                                    | Default               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `--project`    | The project directory. Every write stays inside it.                                                                                                                        | The current directory |
| `--app`        | An application (`src/app.ts#App`) to extract the spec from when the project has no `afora.json`. Importing it needs Bun on the `PATH`.                                     | None                  |
| `--providers`  | A module, as a path from the project, exporting `providers` (or a default export): `{ name, module, export }[]`, the providers `provider.use` may name besides `inMemory`. | None                  |
| `--stages`     | The same for the stages of an output's `pipe`: `{ name, module, export, kind? }[]`; `select` and `openapi` are built in.                                                   | None                  |
| `--policies`   | The same for the event policies of a command: `{ name, module, export }[]`; `publishEvents` is built in.                                                                   | None                  |
| `-h`, `--help` | Prints the usage to standard error (standard output carries the protocol) and exits `0`.                                                                                   |                       |

The catalog paths are resolved from `--project` here, not from the current directory as in `afora-codegen`.

**Exit codes.** `0` after the usage; `2` for an unknown flag or a flag without its value; `1` when it cannot start (for example a catalog module that does not export an array).

**Adding it to an agent.**

```bash
claude mcp add afora -- bunx @afora/mcp --project .
```

Any MCP client that starts a stdio server takes the same command and arguments.

### Tools

| Tool                  | What it does                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afora_catalog`       | What a spec can use: Std properties, record plugins, reserved keys, repository action rules, exception layers, core exceptions, and the catalogs given by the flags.                     |
| `afora_project`       | The project as a map, read-only: entities, repositories, operations with their route and access, outputs. Reads an `--app` directly, else `afora.json`; lists drift when both exist.     |
| `afora_spec_read`     | Reads `afora.json` with its issues; with no file and an `--app`, the spec extracted from that code (not written).                                                                        |
| `afora_extract`       | Extracts the spec of an application of the project, in a Bun subprocess. Writes nothing.                                                                                                 |
| `afora_spec_validate` | Validates a draft spec, or the file on disk; gives `{ valid, issues }`.                                                                                                                  |
| `afora_spec_upsert`   | Adds or replaces one declaration, validates the whole spec and writes only if it is valid.                                                                                               |
| `afora_spec_remove`   | Removes one declaration; writes only if the spec stays valid.                                                                                                                            |
| `afora_spec_write`    | Replaces the whole spec, validated first.                                                                                                                                                |
| `afora_generate`      | `dryRun: true` returns the files; otherwise writes them, then runs `bunx tsc --noEmit -p <project>` when there is a `tsconfig.json`, and returns the diagnostics of the generated files. |

Three resources are available as well: `afora://spec/schema` (the JSON Schema of `afora.json`), `afora://catalog` and `afora://spec/guide` (a short guide for the agent). The [mcp README](../packages/mcp/README.md) has the details of each tool and of what the server runs.
