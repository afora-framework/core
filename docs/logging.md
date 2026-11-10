# Logging

afora can tell a logger what it runs: each use case, each command and each repository call a use case makes, with the time it took, and each failure, once. It logs nothing until you give it one.

```ts
import { configure, type Logger } from "@afora/core";

const logger: Logger = {
	debug: (event, fields) => console.debug(event, fields), // optional
	info: (event, fields) => console.info(event, fields),
	warn: (event, fields) => console.warn(event, fields),
	error: (event, fields) => console.error(event, fields),
};
configure({ logger }); // `configure({ logger: null })` or `resetRuntime()` turns it off
```

`Logger` has one method per level, each taking an event name and a plain object of fields, so it fits most structured loggers (pino, a `console` wrapper, a Lambda JSON log) as is. `debug` is optional: without it, only failures are written.

## Events

| Event             | Level         | Fields                                  | When                                                         |
| ----------------- | ------------- | --------------------------------------- | ------------------------------------------------------------ |
| `use-case`        | debug         | `useCase`, `outcome: "ok"`, `ms`        | A use case returned.                                         |
| `repository`      | debug         | `repository`, `method`, `useCase`, `ms` | A repository method returned, called by a use case.          |
| `command`         | debug         | `command` (`Name.operation`), `ms`      | A command operation returned (after its transaction).        |
| `use-case-failed` | warn or error | `useCase`, `ms`, `exception`            | A use case threw.                                            |
| `command-failed`  | warn or error | `command`, `ms`, `exception`            | A command threw outside any use case (its context, its env). |

A failure is `warn` when it is a declared exception (one made by `exceptionOf`, such as a not found or a conflict) and `error` when it is unexpected (an `UnexpectedError`: anything else thrown, wrapped by [`guard`](exceptions.md)). `exception` is its `toJSON()`: the name, layer, source, message and details of the step where it surfaced, and its `trace`.

The same exception goes up through every use case and command that called the one that threw, each wrapping it. It is logged once, at the first of them, keyed by its `origin`.

Repository calls are logged only through a use case: calling a repository directly, outside one, logs nothing. Arguments, inputs and responses are never logged, as they can hold sensitive values; add them in your own code if you need them.

## Guarantees

- A logger that throws never breaks the call it logs.
- With no logger (the default) the cost is a clock read and a check per call.
- The logger is per process, like the password hasher and the id generator (see the [README](../README.md#install)). Tests that set one should call `resetRuntime()` after.
