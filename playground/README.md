# afora playground

A local TypeScript playground for the project you launch it from. Its Monaco editor uses a local TypeScript language service to resolve the project's actual installed dependencies and `tsconfig.json` (including path aliases). The `package.json` panel shows declared and installed versions; **Atualizar projeto** reloads the manifest and language service after dependency/configuration changes.

## Developing afora

From the repository root:

```sh
bun install
bun run playground
```

Open http://127.0.0.1:4317. This command builds the playground and uses `src/index.ts` for both execution and IntelliSense. Changes to library code are picked up by the next execution; use **Atualizar projeto** to refresh types. Restart the command after changing the playground itself.

## Using it in another project

Once a version containing the playground is installed, add this script to that project's `package.json`:

```json
{
	"scripts": {
		"playground": "afora playground"
	}
}
```

Run `bun run playground` (or `npm run playground` with Bun on your PATH). The CLI is included in `@afora/core`; no separate editor installation is needed. Bun >= 1.4.4 is required to launch it, including for projects that normally run on Node. The library itself retains its Node support.

The CLI defaults to the current directory. Optional flags:

```sh
afora playground --project /absolute/path/to/project --port 4318
```

Before publishing, test a consumer directly from this checkout:

```sh
bun run build
bun dist/playground/server.js --project /absolute/path/to/project
```

The consumer must already have its dependencies installed. The editor does not install packages or change `package.json`. A dependency without TypeScript declarations needs its usual `@types` package. The language service bundled with this version is TypeScript 5.9.3; it reads the project configuration but does not switch compiler versions to match the project. Framework-specific compiler plugins and newer TypeScript-only features are outside this initial version.

## Working in the editor

- Write TypeScript with completion, hover types, signature help and inline diagnostics. Imports resolve against the selected project, including local files and `tsconfig` aliases.
- Use **Executar** or **Cmd/Ctrl + Enter**. Each run starts a fresh Bun process with the project as its working directory. Top-level `await` works.
- Inspect expandable console values and layered exceptions. Objects exposing `toJSON()` use that representation, so afora records retain sensitive-field masking.
- **Parar** interrupts execution. Runs have a 10-second timeout, a 1 MB output budget and a 1,000-log display limit.
- The current draft is recovered automatically from this browser. **Salvar** creates/updates a TypeScript file in `.afora/sandbox/<name>.sandbox.ts` in the selected project. Names can include subfolders (for example, `entities/customer`); changing the name renames the file, and existing names are never overwritten when creating or renaming. Edited buffers are saved before switching documents; a failed save keeps the current document open. The sidebar loads saved files from disk, and **Atualizar projeto** reloads the list after external edits. Deleting an experiment removes its file. Existing browser experiments are migrated into this directory with their old IDs appended to avoid name collisions. Imports in the editor and runner remain relative to the project root.
- Examples cover records, validation, passwords, entities/events, repositories, use cases and layered errors. They target the API shipped with the playground; an older afora installed in the target project may have a different API.

This is a development tool for code you trust. It binds to loopback and checks request origins; a separate process is not an OS security sandbox. Executed code has the same filesystem, network and environment access as your local Bun process. Runtime behavior follows Bun, even when the consuming application's production runtime is Node.

## Checks

```sh
bun run test:playground
cd playground
bun check
```

Tests cover source/installed afora completion, a separate consumer's dependencies and aliases, example diagnostics/execution, serialization, cancellation and timeouts.
