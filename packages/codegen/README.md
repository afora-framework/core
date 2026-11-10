# @afora/codegen

Describe a domain in an `afora.json` and generate the idiomatic [`@afora/core`](../../README.md) TypeScript for it: the code someone would write by hand (`blueprintOf`, `entityOf`, `recordOf`, `repositoryOf`, `environmentOf`, `applicationOf`), committed, readable and reviewable. It is codegen, not interpretation at runtime. The inverse works too: `extractSpec(app)` gives the `afora.json` of an `Application`. The workflow, the catalogs and the limitations are collected in the [afora.json guide](../../docs/afora-json.md); the quick start of the [README](../../README.md#the-same-app-as-an-aforajson) is a complete example.

```bash
bun add @afora/core typebox
bun add -d @afora/codegen
```

`@afora/core` and TypeBox (`typebox: ^1`) are peer dependencies. Generated files use the application's dependencies; codegen does not generate a package manifest.

```bash
afora-codegen check [afora.json] [--providers module] [--stages module]                 # validate
afora-codegen generate [afora.json] [--out dir] [--providers module] [--stages module]  # write the code into output.dir
afora-codegen extract src/app.ts#App [--import provider=./db.ts#provider] > afora.json
```

`extract` imports the file, so use Bun (or Node >= 23.6) for TypeScript files. The CLI runs on Node >= 22 or Bun.

## The spec

Repository `actions` also accept the queries `findMany`, `exists` and `findPage` (they need no key; `count` takes an optional query at runtime), generated and extracted like the others.

**Providers.** `provider` at the top of the spec sets the provider of the application, and a repository may declare its own:

```json
{
	"version": 1,
	"name": "accounts",
	"provider": "inMemory",
	"repositories": {
		"Users": {
			"entity": "User",
			"actions": ["findMany", "findPage", "create"]
		},
		"Audit": {
			"entity": "Entry",
			"actions": ["create"],
			"provider": {
				"use": "drizzle",
				"options": { "db": { "import": "./db.ts#db" } }
			}
		}
	}
}
```

A provider is `"inMemory"` (`inMemoryProvider()` of `@afora/core`, built in), `{ "use": "<catalog name>", "options": {...} }` (generated as `drizzleProvider({ db })`) or `{ "import": "./db.ts#provider" }` (a provider created by hand, generated as a named import). Options recurse over JSON values and `{ "import": "./x.ts#y" }` references, which become named imports; imports are relative to the output directory (or a package), and the validator never evaluates them. Issues: `unknown_provider` (a name outside the catalog), `invalid_provider` (wrong shape or a non-JSON option), `invalid_import` (not `module#exportName`) and `invalid_provider_catalog` (a bad catalog entry).

**Named providers.** The top-level `providers` declares providers by camelCase key, and a repository (or the top-level `provider`) names one with a string:

```json
{
	"version": 1,
	"providers": {
		"main": "inMemory",
		"audit": { "import": "./audit.ts#audit" }
	},
	"provider": "main",
	"repositories": {
		"AuditLogs": {
			"entity": "AuditLog",
			"actions": ["create"],
			"provider": "audit"
		}
	}
}
```

It is generated as `providers.ts` (`export const Providers = providersOf({ ... })`), with `provider: Providers.audit` in `repositories.ts` and `providers: Providers, provider: Providers.main` in `application.ts`. Each value is a provider as above, never a key. A key is camelCase and not `"inMemory"` (`invalid_provider_key`); a string that is neither `"inMemory"` nor a key is `unknown_provider`, and the message lists the keys; one key declared by this spec and a spec it extends is `provider_conflict`. Keys of a spec extended directly can be named. Extraction gives the keys back, and a provider of `providers` created without `providerOf` needs the import key `providers.<key>`.

External providers are not part of `afora.json`: the catalog is a codegen option, `{ providers: [{ name: "drizzle", module: "@acme/drizzle", export: "drizzleProvider" }] }`, passed to `validateSpec(spec, extended, options)` and `generate(spec, extended, options)`. The CLI reads it from a module with `--providers <module>` (exporting `providers`, or as the default export, an array of such entries). `module` is a package or a path relative to the output directory and `export` is the factory, called with the options object (omitted when there are none). Normalization treats `"inMemory"` as `{ "use": "inMemory", "options": {} }`, and never treats an omitted provider as a shared one: a repository without `provider` uses the application's.

Extraction reads `app.describe()`. A provider created with `providerOf({ name, options, create })` comes back as `"inMemory"` or `{ use, options }`; the options are the JSON ones given to `providerOf` (a value that was an import reference when generating is not recovered). A provider created without `providerOf` is opaque and needs `extractSpec(app, { imports: { provider: "./db.ts#provider" } })` (the application's) or `{ "repositories.Users.provider": ... }`, in the CLI `--import key=./file.ts#name`; without it extraction throws an `ExtractionError` naming the key instead of defaulting to memory.

Repositories accept `"deletion": "hard" | "soft"`. The default is `"hard"`; `"soft"` retains rows with `deletedAt` and hides them from reads, counts and relations. Extraction preserves `"soft"`; normalization omits explicit `"hard"` as the default. Invalid values produce an `invalid_deletion` issue.

`blueprint` and `options` are valid field names in records and entities. Their instance metadata lives under the core's `Meta` symbol; the JSON spec and class statics keep their existing shape.

```jsonc
{
	"$schema": "./node_modules/@afora/codegen/afora.schema.json",
	"version": 1,
	"name": "blog",
	"output": { "dir": "src/domain" },
	"properties": {
		"Age": {
			"base": "integer",
			"with": { "min": 0, "max": 150, "description": "In years" }
		},
		"Status": { "enum": ["draft", "published"] }
	},
	"blueprints": {
		"Address": {
			"fields": {
				"street": "string",
				"zip": { "type": "string", "with": { "pattern": "^\\d{5}-\\d{3}$" } }
			}
		}
	},
	"entities": {
		"User": {
			"fields": {
				"name": "text",
				"email": "email",
				"slug": "slug",
				"password": "password",
				"age": "Age?",
				"address": "Address",
				"tags": "string[]"
			},
			"unique": ["email"],
			"change": ["name"]
		},
		"Post": {
			"fields": {
				"title": "text",
				"status": "Status",
				"author": "User",
				"coauthors": "User[]"
			}
		}
	},
	"environments": {
		"Database": { "fields": { "DATABASE_URL": "url", "PORT": "integer" } }
	},
	"repositories": {
		"Users": {
			"entity": "User",
			"actions": ["findById", "findByEmail", "create", "update"],
			"environments": ["Database"]
		},
		"Posts": {
			"entity": "Post",
			"actions": ["findById", "findManyByAuthor", "create"],
			"relations": ["Users"]
		}
	}
}
```

Generated (`src/domain/entities.ts`):

```ts
// Generated by @afora/codegen from afora.json. Do not edit.

import { blueprintOf, entityOf, optionalOf } from "@afora/core";
import { Address } from "./blueprints";
import { Age } from "./properties";

export class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		// ...
		age: optionalOf(Age),
		address: Address,
		tags: ctx.list.string,
	})),
	{
		name: "User",
		unique: ["email"],
		change: ["name"],
	},
) {}
```

**Fields.** A string is a shorthand: `"email"`, `"Age?"` (optional), `"string[]"` (list), `"User[]?"` (optional list). The object form is `{ "type", "optional", "list": true | { "minItems", "maxItems" }, "with": {...} }`, `{ "enum": [...] }` or `{ "fields": {...} }` (a nested object). Lowercase names are Std properties (`email`, `text`, `integer`, ...), PascalCase names are declarations of the spec. `with` is `Property.with` / `ctx.<property>(options)` and only takes the options valid for the type (`pattern` is not valid for an `integer`).

**Declarations.** `properties` are `{ base, with?, optional? }`, `{ enum, name?, default? }` or `{ opaque: true, ref?, import }` (a hand-written property, imported relative to the output directory instead of recreated). `blueprints` and `environments` have `fields`. `records` and `entities` have `fields`, `sensitive`, `unique`, `change` and `plugins` (`authenticatable`, `taggable`, ...); each is generated with its key as its declared `name` (`entityOf(blueprint, { name: "User" })`), so providers that find a table by name keep working when the application is minified. `repositories` have `entity`, `actions`, `provider`, `deletion`, `relations` and `environments`. `exceptions` are `{ layer, message? }` (`layer` is one of `ExceptionLayers`; the message is `"<Name>."` when omitted). `useCases`, `commands` and `outputs` are described below.

**Use cases.** `{ description?, tags?, deprecated?, input, response, context?, dependencies?, errors?, implementation }`. `input`, `response` and `context` are a blueprint name or `{ "fields": {...} }`; `dependencies` maps a key to a declared use case, repository or environment; `errors` lists declared exceptions or exceptions exported by `@afora/core` (`catalog().coreExceptions`). The implementation is either `{ "steps": [...] }`, the steps DSL (`find`, `ensure`, `build`, `change`, `invoke`, `create`/`update`/`delete`, `call`, `run`, `return`; the same data as the TypeScript form, with class names for `build`/`ensure.error` and `{ "import": "./file.ts#fn" }` for `run.fn`), generated as a complete `class Register extends useCaseOf({ ..., steps: [...] }) {}`, or `{ "import": "../handlers/register#Register" }`, a hand-written class: the generated file has `export abstract class RegisterBase extends useCaseOf({...}) {}`, your class extends it and implements `execute`, and `application.ts` registers your class (`index.ts` re-exports it). Imports are relative to the output directory. A use case cannot list an imported use case as a dependency (its handler imports the generated file that would import it back). Step rules are validated with the codes the core uses in `InvalidUseCaseStep` (`unknown_step`, `invalid_reference`, `unbound_reference`, `unknown_key`, `unknown_dependency`, `unknown_action`, `write_in_find`, `undeclared_error`, `missing_return`, `misplaced_return`, `invalid_step_name`, `invalid_class`, `invalid_change_key`, `invalid_value`, `invalid_step`) plus `unknown_exception`, `unknown_blueprint`, `invalid_import`, `import_dependency`.

**Commands.** `{ description?, tags?, context?, useCases, transaction?, environments?, events?, onEventError? }`, generated with `commandOf` in `commands.ts`. `useCases` maps an operation name (an identifier) to a declared use case (a hand-written one is imported from its handler); `context` is a blueprint name or `{ "fields": {...} }`. `transaction: true` runs each call in a transaction of the repositories' provider; the provider is unknown when the spec is validated, so this is checked when the code runs (`commandOf` throws `InvalidCommandDeclaration` for a provider without transactions), not by `validateSpec`. `environments` lists declared environments, generated as `environmentDependencies` (`command.env`, the event handlers and the use cases that declare them get their variables). `events` is `"after-commit"` (the default), `"manual"` or `{ "import": "./events.ts#dispatch" }` (a handler written by hand); `onEventError` is an import and only valid with `after-commit`. Normalization drops `transaction: false`, `environments: []`, `events: "after-commit"` and `tags: []`. Issues: `unknown_use_case`, `unknown_environment`, `duplicate_environment`, `invalid_use_cases`, `invalid_operation`, `wrong_kind`, `invalid_events`, `event_error_requires_after_commit`, `invalid_import`, `invalid_option`. Extraction reads `describe().commands` (`imports` keys `commands.<Name>.events` and `commands.<Name>.onEventError`, else `ExtractionError`).

**Outputs.** `{ commands, statuses?, pipe }`, generated with `outputOf` in `outputs.ts`. `commands` are declared commands; `statuses` maps an exception name (declared or exported by `@afora/core`) to a status from 400 to 599; `pipe` is a list of `{ "transform": name, "options"?: {...} }`, then at most one `{ "sink": name, "options"?: {...} }` as the last stage, or `{ "import": "./stages.ts#auth" }` for a stage written by hand. Options are JSON. Normalization drops empty `statuses` and `options`. Issues: `unknown_command`, `invalid_commands`, `duplicate_command`, `invalid_pipe`, `invalid_stage`, `unknown_stage`, `stage_kind_mismatch`, `sink_not_last`, `invalid_stage_options`, `invalid_statuses`, `invalid_status`, `unknown_exception`, `invalid_stage_catalog`. The stage catalog is a codegen option like the provider one: `{ stages: [{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" }] }` in `validateSpec(spec, extended, options)` and `generate(spec, extended, options)`, and `--stages <module>` (exporting `stages`, or a default export) in the CLI. `select` and `openapi` come from `StdStages` of `@afora/core` and are always available (`catalog().stages` lists them with their kind); `kind` is optional on an external entry and, when given, checks `transform` / `sink`. Extraction reads `describe().outputs` (`imports` key `outputs.<Name>.pipe.<index>` for a stage written by hand).

A complete `afora.json` with exceptions, use cases with steps, a command and an output:

```json
{
	"version": 1,
	"name": "blog",
	"provider": "inMemory",
	"blueprints": {
		"RegisterInput": { "fields": { "name": "text", "email": "email" } }
	},
	"entities": {
		"User": {
			"fields": { "name": "text", "email": "email" },
			"unique": ["email"]
		}
	},
	"repositories": {
		"Users": { "entity": "User", "actions": ["findByEmail", "create"] }
	},
	"exceptions": {
		"UserAlreadyExists": { "layer": "use-case", "message": "Taken." }
	},
	"useCases": {
		"Register": {
			"input": "RegisterInput",
			"response": { "fields": { "user": "User" } },
			"dependencies": { "users": "Users" },
			"errors": ["UserAlreadyExists"],
			"implementation": {
				"steps": [
					{
						"find": "users.findByEmail",
						"args": ["$input.email"],
						"as": "existing"
					},
					{
						"ensure": "absent",
						"value": "$existing",
						"error": "UserAlreadyExists"
					},
					{
						"build": "User",
						"values": { "name": "$input.name", "email": "$input.email" },
						"as": "user"
					},
					{ "create": "users", "value": "$user", "as": "saved" },
					{ "return": { "user": "$saved" } }
				]
			}
		}
	},
	"commands": {
		"Accounts": {
			"tags": ["public"],
			"useCases": { "register": "Register" },
			"transaction": true
		}
	},
	"outputs": {
		"Api": {
			"commands": ["Accounts"],
			"statuses": { "UserAlreadyExists": 409 },
			"pipe": [
				{ "transform": "select", "options": { "tags": ["public"] } },
				{
					"sink": "openapi",
					"options": { "info": { "title": "Blog", "version": "1.0.0" } }
				}
			]
		}
	}
}
```

Generated `commands.ts` and `outputs.ts`:

```ts
export const Accounts = commandOf({
	name: "Accounts",
	tags: ["public"],
	useCases: { register: Register },
	transaction: true,
});

export const Api = outputOf({
	name: "Api",
	commands: [Accounts],
	statuses: { UserAlreadyExists: 409 },
	pipe: [
		select({ tags: ["public"] }),
		openapi({ info: { title: "Blog", version: "1.0.0" } }),
	],
});
```

`App.outputs.Api.build()` is the OpenAPI document. Names are shared by every kind of declaration, so a command cannot be called `Users` while a repository already is.

**Extending.** `"extends": ["../auth/afora.json", "@acme/auth"]` uses the declarations of other specs (a relative path to their `afora.json`, or a package that exports `./afora.json` and the generated code). The same name for different declarations is a conflict; the same declaration reached twice is registered once. The generated `application.ts` extends their `App`.

**Output.** One file per kind in `output.dir` (`properties.ts`, `blueprints.ts`, `records.ts`, `entities.ts`, `environments.ts`, `repositories.ts`, `exceptions.ts`, `use-cases.ts`, `commands.ts`, `outputs.ts`), `application.ts` with `export const App = applicationOf({...})` and `index.ts`, each starting with `// Generated by @afora/codegen from afora.json. Do not edit.`. Kinds that need each other share one file (no import cycles), and the code is formatted as Biome would. To add behavior, extend the generated class in a file of your own. Limitation: repositories point at the generated classes.

## API

```ts
import {
	catalog,
	generate,
	validateSpec,
	extractSpec,
	normalizeSpec,
	loadSpec,
	writeGenerated,
	specSchema,
} from "@afora/codegen";

const { spec, extended } = await loadSpec("afora.json"); // also reads what it extends
const issues = validateSpec(spec, extended); // [{ path, code, message }], never throws
const files = generate(spec, extended); // [{ path, contents }], deterministic
await writeGenerated(projectDir, files); // confined to the project, banner-checked
const again = extractSpec(App, { extends: { auth: "../auth/afora.json" } });
```

- `validateSpec(spec, extended?, { providers, stages }?)` reports unknown references, name collisions, cycles, reserved and identity keys, `unique`/`sensitive`/`change` naming missing keys, repository action rules (`findBy<Key>` only for unique keys: `id`, `unique`, `slug` fields and unique plugin keys; `findManyBy<Key>` only for the others), `relations` that do not cover exactly the entities held at any depth, and `with` options invalid for the type. Each issue has a stable `code`.
- `generate(spec, extended?, { providers, stages }?)` throws `InvalidSpecError` (with `issues`) for an invalid spec.
- `catalog()` is read from `@afora/core` at runtime (`Std.properties`, `Std.factories`, `StdRecordPlugins`, the reserved keys): nothing is a list kept by hand.
- `extractSpec(app, { extends, outputDir, imports })` is the inverse of `generate`: `spec -> generate -> import -> extractSpec` gives back the same spec (`normalizeSpec` makes shorthand and object forms compare equal). Properties with custom handlers become opaque imports. Use cases: a steps use case comes back as steps (its `run` functions need `imports` `useCases.<Name>.run.<name>`), a hand-written `execute` as `{ import }` (`imports` `useCases.<Name>`), otherwise `ExtractionError` names the key. Commands and outputs come back as in the sections above. The input, response and context come back as the name of the registered blueprint (`describe().refs`) and as `{ fields }` when it was not registered, and an exception whose message is a function comes back without `message`, so generation gives it the default `"<Name>."`. Constructs the core does not describe (a `change` on a plugin key, the order of `plugins`) are not recovered.
- `writeGenerated(root, files)` writes only inside `root` (no `..`, no symlink out), overwrites and removes only files that carry the banner, and writes nothing if one is refused.
- `afora.schema.json` is the JSON Schema of the spec, for editors.

**Round trips.** `bun run test:roundtrip` (also run by CI beside `test:codegen`) proves both directions on complete applications, in `tests/roundtrip/`: specs that use every feature are generated, type-checked, linted, run and extracted back to the same normalized spec, and hand-written applications (with `execute`, `run` functions, an anonymous provider, a stage written by hand and function messages) are extracted with an `imports` map, generated and held to the same behavior functions as the original. An unmapped hand-written piece makes extraction throw an `ExtractionError` naming its key; an opaque property is the exception, it falls back to `./opaque`.

Generated code type-checks with TypeScript 5.5 or newer.
