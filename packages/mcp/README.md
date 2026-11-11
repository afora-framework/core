# @afora/mcp

Repository declarations accept `deletion: "hard" | "soft"` (default `hard`), the actions `findMany`, `exists`, `findPage` and `findCursor`, and a `provider` (`"inMemory"`, `{ use, options }` or `{ import }`); the application's provider is the top-level `provider` of the spec (`afora_spec_write`). An invalid provider is an issue (`unknown_provider`, `invalid_provider`, `invalid_import`) and nothing is written. `afora_extract` takes `imports` (`provider`, `repositories.<Name>.provider`) for a provider created without `providerOf`. The tools validate the setting and preserve soft deletion when generating or extracting an application.

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets an agent build a domain with afora: discover the catalog, edit an `afora.json`, validate it, generate the code with [`@afora/codegen`](../codegen/README.md) and get the TypeScript diagnostics of what was generated. The spec it edits is described in the [afora.json guide](../../docs/afora-json.md).

The project needs `@afora/core` and TypeBox (`typebox: ^1`) as peer dependencies; install them with `bun add @afora/core typebox`.

```bash
claude mcp add afora -- bunx @afora/mcp --project .
# or: afora-mcp --project <dir> [--app src/app.ts#App] [--providers afora.providers.ts] [--stages afora.stages.ts]
```

`--project` is the project directory (the current one by default); every write stays inside it. `--app` names an `Application` (`file.ts#Export`) to extract the spec from when the project has no `afora.json`. Importing the application needs Bun on `PATH`. `--providers` is a module (a path from the project) exporting `providers`, or a default export: an array of `{ name, module, export }` that `provider.use` may name besides the built-in `inMemory`; `afora_catalog` lists them. `--stages` is the same for the stages an output's `pipe` may name (entries `{ name, module, export, kind? }`; `select` and `openapi` are built in and listed under `stages`).

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afora_catalog`       | What a spec can use, read from `@afora/core`: Std properties (flags and the `with` options each takes), record plugins, reserved keys, repository action rules, exception layers, core exceptions.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `afora_project`       | The project as a map, read-only: entities, repositories, every operation with how it is implemented, its declared route and access, and each output with the route every operation is served at and who may call it. Reads a TypeScript application directly (`--app` or `app`), with no `afora.json`, else the file; `source: "file"` reads `afora.json` even when there is an application. When the project has both, `drift` lists where they differ (declarations in only one, an operation implemented, routed or protected differently, another path in an output); `compare: false` skips it. |
| `afora_spec_read`     | Reads `afora.json` with its issues; with no file and an `--app`, the spec extracted from that code (not written).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `afora_extract`       | Extracts the spec of an `Application` of the project (a Bun subprocess imports it). Writes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `afora_spec_validate` | Validates a draft `spec`, or the file on disk; returns `{ valid, issues }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `afora_spec_upsert`   | Adds or replaces one declaration (`kind` + `name` + `declaration`; kinds include `exception`, `useCase` (with steps), `command` and `output`); validates the whole spec and writes only if it is valid.                                                                                                                                                                                                                                                                                                                                                                                              |
| `afora_spec_remove`   | Removes one declaration; writes only if the spec stays valid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `afora_spec_write`    | Replaces the whole spec (validated first).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `afora_generate`      | `dryRun: true` returns the files. Otherwise writes them, then runs `bunx tsc --noEmit -p <project>` if there is a `tsconfig.json` and returns only the diagnostics of the generated files.                                                                                                                                                                                                                                                                                                                                                                                                           |

`afora_extract` takes `imports` (`useCases.<Name>`, `useCases.<Name>.run.<name>`, `commands.<Name>.events`, `commands.<Name>.onEventError`, `outputs.<Name>.pipe.<index>`) for hand-written use cases, `run` functions, command handlers and stages. Resources: `afora://spec/schema` (JSON Schema of `afora.json`), `afora://catalog` and `afora://spec/guide` (a short guide for the agent: workflow, shape, rules). The `inputSchema` of each tool is JSON Schema derived from the same TypeBox schema as the spec.

## Expose an output as MCP tools

`mcpTools` is a sink stage of an afora output: it turns the operations of the output into MCP tools, so an agent can call your domain directly (the same operations `@afora/hono` serves over HTTP).

```ts
import { outputOf } from "@afora/core";
import { mcpTools } from "@afora/mcp";

const Tools = outputOf({
	name: "Blog",
	commands: [Users, Posts],
	statuses: { Unauthorized: 401 },
	pipe: [
		mcpTools({
			name: "blog",
			version: "1.0.0",
			prefix: "blog_",
			context: { authorization: "authorization" },
		}),
	],
});

const mcp = Tools.build(); // { tools, call, register, server }
await mcp.server().connect(transport); // any transport of the MCP SDK
```

- Options (JSON, so the stage can live in `afora.json`): `name`, `version` (of the server `server()` creates), `prefix`, `include` (operation ids; all by default), `context` and `auth`.
- One tool per operation, named `{prefix}{command}_{operation}` in snake case (`blog_users_register`). The description is the operation one (plus `Deprecated.`) and `inputSchema` is the JSON Schema of the input, inline, with no `$ref`.
- A call runs `operation.invoke(args, { context, principal })` and answers one text content with the response as JSON; sensitive values are masked.
- **Access.** A tool whose use case declares an [`access`](../../docs/auth.md) checks the caller before it runs and answers a 401 or 403 problem. The caller is `extra.principal` of `call`, else what the `authenticator` hook gives (`mcpTools(options, { authenticator })`: its `request.header(name)` reads the values of the call), else the token of the `auth` option (`auth: { jwt: { secret: { env } } }`, experimental, read from the value `authorization`). With none of them such a tool always answers 401. Its description says what it requires, and a tool whose use case declares a route carries the hints `readOnlyHint` (a `get`) and `destructiveHint` (a `delete`).
- Errors answer `isError: true` with the RFC 9457 problem as JSON text; its `status` comes from `statusOf` (the output `statuses` first). Invalid input is a 400 with `issues`, an unknown tool a 404.
- Context: `context: { token: "authorization" }` fills `context.token` from the value named `authorization` in `extra.values` of `call(name, args, extra)`. With `register`/`server()`, the values are the HTTP headers of the request (lower-case) and the string entries of the request `_meta`.
- The result is `{ tools, call(name, args, extra?), register(server), server() }`: `register` installs `tools/list` and `tools/call` on a low-level SDK `Server`, `server()` returns a new one with the `tools` capability.
- For codegen, `stages` and `McpStages` are exported (`--stages @afora/mcp`): `{ name: "mcpTools", module: "@afora/mcp", export: "mcpTools", kind: "sink" }`.

## A project written in code

The server does not need an `afora.json`. Started with `--app src/app.ts#App`, it reads the application the project already has:

- `afora_project` imports the module in a Bun subprocess and reads `app.describe()`, so it sees hand-written use cases, `@Route` and `@Access`, and needs no mapping of what a spec cannot express.
- The guide (`afora://spec/guide`) tells the agent how to add to such a project: in TypeScript, in the style it finds, and then to call `afora_project` again to see the operation listed with its route and access.
- The guide also says when a use case is steps and when it is code: steps for a rule that is a sequence, a `run` step for one computed value, and an `import` use case as soon as the rule branches or loops.

## Safety

**The trust model.** The server runs on your machine, as you, for one project directory. Its input comes from an agent, and is treated as untrusted: a spec, a declaration or a tool argument may name a path or a module, and none of them may leave the project.

- Writes are confined to the project: paths are resolved, `..` and symlinks that leave the project are rejected (also for `afora.json` itself and for `output.dir`).
- **What a spec names stays inside it.** Every `{ "import": "<module>#<name>" }` (the function of a `run` step, a hand-written use case, the `before` and `after` of a standard one, a stage, a provider, a handler, a publisher) and every `extends` must be a package or a file inside the project: a relative module is resolved from `output.dir`, as the generated code imports it, and an absolute path or a URL is refused. The issue is `outside_project`, and such a spec is neither written nor generated from, even when `afora.json` was edited by hand. An `extends` outside the project is not read.
- **The application file is inside it.** `--app` and the `app` of `afora_extract` and `afora_project` are confined the same way.
- **What it runs.** `afora_extract` and `afora_project` (with an application) import the module in a Bun subprocess, which runs the code of your project, as `bun src/app.ts` would; `afora_generate` runs `tsc` on it. Nothing an agent sends is executed: it can only name files of the project to import. An agent that can also write files in the project (with its own tools) can make the project run what it wrote; that is the permission you gave the agent, not the server.
- **What it does not protect.** A package named in an `import` is resolved from the dependencies of the project; the server does not install packages and does not vet them. The server has no network access of its own and no authentication: it speaks stdio to the client that started it.
- A generated file is overwritten or removed only if it starts with the banner `// Generated by @afora/codegen from afora.json. Do not edit.`. If any file would be refused (it exists without the banner) nothing is written.
- Nothing else is touched. An invalid spec is never written.

## Programmatic use

```ts
import { createServer } from "@afora/mcp";

const server = await createServer({
	project: "/path/to/project",
	stages: [
		{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" },
	],
	providers: [
		{ name: "drizzle", module: "@acme/drizzle", export: "drizzleProvider" },
	],
});
await server.connect(transport); // any transport of the MCP SDK
```
