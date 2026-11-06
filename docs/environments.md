# Environments

`environmentOf(blueprint, { source })` describes the variables a program needs, e.g. `{ DATABASE_URL: ctx.url, PORT: ctx.integer }`. It reads the declared variables from `process.env` (or from `source`, e.g. `() => Bun.env`), validates them on the first `load()` and keeps the value; a missing or rejected variable throws `InvalidEnvironment` (`Environment` layer). The blueprint must not be optional.

Pass one environment, or a list (merged in order), as `environmentDependencies` of a repository: the provider gets them as `context.env`, read on the first call, not on declaration. As a dependency of a use case, the use case gets the variables, and `execute` can replace some of them with values its blueprint accepts (see [Use cases](use-cases.md) and [Repositories](repositories.md)).

```ts
import { blueprintOf, environmentOf, repositoryOf } from "@afora/core";

const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
);
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById"],
	provider: postgres,
	environmentDependencies: [Database],
});
```

A variable is converted when its property does not take a string: to `true` or `false` (from `"true"` and `"false"`) for a boolean, and to a number for a number, e.g. `PORT: ctx.integer` reads `"3000"` as `3000`, and `DEBUG: ctx.boolean` reads `"true"` as `true`. A property that takes a string keeps the variable as is, so `"10"` stays a string for `ctx.string`. A value that does not convert is left for the blueprint to reject.

As `environmentDependencies` of a command, `command.env` gives the variables, the event handlers get them as `info.env`, and a call can replace some of them with `run(op, input, { env })` for the use cases that declare the same environment (see [Commands](commands.md#environments)).

`await app.start()` validates every environment of an application at once, and `providerFrom(Database, (env) => ...)` makes its provider from their variables (see [Applications](applications.md#starting)).

An application registers environments in `environments` and `app.describe()` lists them ([Applications](applications.md)).
