# Logging

An application logs through the providers of its `log`, as its repositories read and write through their provider. A log provider (`ILogProvider`) is where lines go: the console, JSON on stdout, a log service, memory. From them the application builds an `ILogger`, which logs what afora runs and what you write. Without a `log` nothing is written.

```ts
import { applicationOf, jsonLogProvider } from "@afora/core";

export const App = applicationOf({
	name: "blog",
	// ...
	log: {
		level: "info", // lines below it are dropped; "info" by default
		providers: [jsonLogProvider()], // one or several
	},
});
```

## Log providers

| Provider               | What it writes                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| `jsonLogProvider()`    | One JSON object per line on stdout: for Lambda, containers, CloudWatch. |
| `consoleLogProvider()` | A readable line on the console, by level: for local development.        |
| `memoryLogProvider()`  | Nothing: it keeps the lines in `entries` (and `clear()`), for tests.    |

Your own implements `write(entry)`, and `flush()` if it buffers. `logProviderOf` checks it and, with a `name`, lets `describe()` name it:

```ts
import { logProviderOf } from "@afora/core";

const datadog = logProviderOf({
	name: "datadog",
	write: (entry) => buffer.push(entry),
	flush: () => send(buffer.splice(0)),
});
```

Each line is a `LogEntry`: `at` (ISO 8601), `level`, `event`, `fields` and `application` (the name of the application that wrote it). Each provider gets every line at or above the level. A provider that throws, or whose `write` rejects, breaks neither the call it logs nor the other providers. `app.stop()` awaits the `flush()` of each.

## The logger

`ILogger` has `debug`, `info`, `warn` and `error`, each `(event, fields?)`. Where you get it:

- `app.logger`, and `app.context.logger` (see [Applications](applications.md#the-context-of-an-application)).
- A use case that declares `Logger` as a dependency:

  ```ts
  import { Logger, useCaseOf } from "@afora/core";

  class ImportPosts extends useCaseOf({
  	name: "ImportPosts",
  	blueprint: ImportInput,
  	response: ImportResponse,
  	dependencies: { posts: Posts, logger: Logger },
  }) {
  	override async execute({
  		posts = this.dependencies.posts,
  		logger = this.dependencies.logger,
  	} = {}) {
  		logger.info("import-started", { rows: this.input.rows.length });
  		// ...
  	}
  }

  // In a test: any ILogger
  await new App.useCases.ImportPosts(input).execute({ logger: fakeLogger });
  ```

  `Logger` needs no registration in the application. In an `afora.json` it is `"dependencies": { "logger": "Logger" }`.
- An event handler, next to the entity: `eventOf("published", Post, async (post, { logger }) => ...)`. A command's handler policy and `onEventError` get it as `info.logger` (see [Commands](commands.md)).

Which application's logger: the one that bound the use case or command (`App.useCases.X`, `App.commands.X`); for a use case or an event run outside one, the started application's (`app.start()`); a logger that writes nothing when there is neither.

## What afora logs

| Event             | Level         | Fields                                  | When                                                         |
| ----------------- | ------------- | --------------------------------------- | ------------------------------------------------------------ |
| `use-case`        | debug         | `useCase`, `outcome: "ok"`, `ms`        | A use case returned.                                         |
| `repository`      | debug         | `repository`, `method`, `useCase`, `ms` | A repository method returned, called by a use case.          |
| `command`         | debug         | `command` (`Name.operation`), `ms`      | A command operation returned (after its transaction).        |
| `use-case-failed` | warn or error | `useCase`, `ms`, `exception`            | A use case threw.                                            |
| `command-failed`  | warn or error | `command`, `ms`, `exception`            | A command threw outside any use case (its context, its env). |

A failure is `warn` when it is a declared exception (one made by `exceptionOf`, such as a not found or a conflict) and `error` when it is unexpected (an `UnexpectedError`: anything else thrown, wrapped by [`guard`](exceptions.md)). `exception` is its `toJSON()`: the name, layer, source, message and details of the step where it surfaced, and its `trace`.

The same exception goes up through every use case and command that called the one that threw, each wrapping it. It is logged once, at the first of them that has a logger, keyed by its `origin`.

Repository calls are logged only through a use case: calling a repository directly, outside one, logs nothing. Arguments, inputs and responses are never logged, as they can hold sensitive values; log them yourself where you need them.

The same points make spans when the application has a `trace`: one per command operation, use case and repository call, nested as the calls are. See [Tracing](tracing.md).

## A log made on start

`logFrom((ctx) => log)` makes the `log` on `app.start()`, from the [context](applications.md#the-context-of-an-application) of the application, e.g. to take the level from a variable:

```ts
import { environmentOf, jsonLogProvider, logFrom } from "@afora/core";

const Logging = environmentOf(
	blueprintOf((ctx) => ({
		LOG_LEVEL: ctx.enumOf(["debug", "info", "warn", "error"]),
	})),
);

export const App = applicationOf({
	name: "blog",
	environments: { Logging },
	log: logFrom((ctx) => ({
		level: ctx.env(Logging).LOG_LEVEL,
		providers: [jsonLogProvider()],
	})),
});
```

It is made before the provider, so a `providerFrom` can already log. Nothing is written before `start()`; `stop()` flushes and forgets it, and the next `start()` makes it again. `describe()` gives it as `{ kind: "opaque" }`; in an `afora.json` it is `"log": { "import": "./log.ts#log" }`.

## Extending

An application that `extends` another without a `log` of its own logs through the same providers, under its own name; `app.extend(Other)` keeps the `log`. A `trace` is inherited and kept the same way ([Tracing](tracing.md#extending)).
