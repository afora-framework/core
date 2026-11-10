# Applications

`applicationOf` gathers the declarations of an app in one named, immutable manifest, so everything runs in one context and can be inspected:

```ts
const Blog = applicationOf({
	name: "blog",
	properties: { Age, Status },
	blueprints: { Address },
	entities: { User, Post },
	environments: { Database },
	repositories: { Users, Posts },
	provider: inMemoryProvider(), // the default of the repositories that declared none
});

Blog.entities.User; // the declarations, by name
Blog.repositories.Users; // typed; bound to Blog's provider
Blog.repository(Users); // the same, from the original
Blog.get(Users); // the same, for any kind of declaration
```

It checks the set as a whole when declared: one object under two names (`DuplicateApplicationDeclaration`), an entity or record held at any depth (fields, lists, optionals, nested blueprints) that is not registered (`UnregisteredApplicationReference`), and a repository whose entity, `relations` or `environmentDependencies` are not (`UnregisteredRepositoryDependency`). A declaration of the wrong kind throws `InvalidApplicationDeclaration`.

`extends: [Auth]`, or `Blog.extend(Billing)`, which returns a new application, inherits declarations; the extended ones stay usable alone and are never changed. The same object under the same name is registered once; one name for different objects, or one object under two names, throws `ApplicationConflict` naming both origins. References may cross applications (a `Post` of `Blog` holding the `User` of `Auth`), and validation runs on the resolved set.

A record or entity that declares a `name` (`entityOf(blueprint, { name: "User" })`, see [Records](records.md)) is registered under that name, `entities: { User }`; another key throws `InvalidApplicationDeclaration`. One without a declared name takes any key.

Use cases are registered by name too: `useCases: { Register, CreateUser }` (concrete classes, keyed by their `useCaseName`) and `exceptions: { UserAlreadyExists }` (made by `exceptionOf`, keyed by their `name`); another key throws `InvalidApplicationDeclaration`. The resolved set (extended applications included) is checked: every dependency of a use case must be registered, a use case, repository or environment (`UnregisteredUseCaseDependency`, with `details.useCase` and `details.dependency`); records and entities held by its `blueprint`, `response` or `context` must be registered (`UnregisteredApplicationReference`); and each class in `errors` must be in `exceptions`, unless it is an exception exported by `@afora/core` such as `RepositoryUniqueViolation` (`UnregisteredApplicationReference` otherwise).

With a `provider`, `providers` or `log`, `app.useCases.Register` is a subclass of `Register` whose `dependencies` swap each repository for the application's bound one, through child use cases too; it is the same subclass every time, and `Register` itself is never changed. Without any of them, `app.useCases.Register === Register`. `app.useCase(Register)` gives the same class from the original, as `app.repository(Users)` does. So a use case that must read and write through the application runs as `new app.useCases.Register(input).execute()`, with no override, or in one call as `await app.run(Register, input)`; `new Register(input).execute()` on the module-level class still uses the module-level repositories.

`app.run(UseCase, input, options?)` builds the bound use case and executes it, returning its response: `options.context` is the context of the use case (required when it declares one) and `options.dependencies` is what its `execute` takes to replace dependencies. The input may be left out when none of its keys is required. It always rejects rather than throws: with `InvalidApplicationDeclaration` for a use case that is not registered, and with what the constructor (invalid input or context) or `execute` raise. The events the use case collected are not handled, since the instance is not returned; a [command](commands.md) is what dispatches them, and `new app.useCases.Register(input)` gives the instance to call `pullEvents()` on.

Commands are registered the same way (`commands: { Users }`, keyed by `commandName`); when the use cases are bound, `app.commands.Users` runs over the bound ones (see [Commands](commands.md)). A use case that a use case plugin made (`ctx.create(Posts)`, see [Use cases](use-cases.md#plugins)) needs no listing: the commands that hold it register it under its `useCaseName`, with the checks of any other use case, so its repository must be registered and two different use cases with one name throw `ApplicationConflict` (give one a `name`). Such a name is not in the type of `app.useCases`; reach the class as `app.commands.Blog.useCases.create`. `describe()` gives it `generic: { name, version, repository, options }` beside its `implementation`, the plugin, the registered repository and the options, with classes among them by name.

Outputs are registered with `outputs: { Api }`, keyed by `outputName` (`InvalidApplicationDeclaration`, which also rejects unnamed outputs made by `.pipe`); every command of an output must be registered in `commands` (`UnregisteredApplicationReference`, `details: { output, command }`). When the commands are bound, `app.outputs.Api` (or `app.output(Api)`) is the output rebuilt over the application-bound commands, with the same name, statuses and stages, memoized, so `invoke` on its operations writes through the application provider. `app.describe().outputs` gives, for each output, `from`, `name`, `commands` (names), `statuses` and `pipe`: each stage as `{ kind: "transform" | "sink", name, options }`, or `{ kind: "opaque" }` for a hand-written stage.

Repositories are module-level and may be shared, so an application does not change them: `app.repositories.Users` shares the declaration of `Users` but reads and writes through the `provider` of the application (or of the last application it extends that has one), unless `Users` declared its own. Two applications with different providers do not share data. Without a `provider`, `app.repositories.Users` is `Users` itself, and records, entities and repositories work the same outside any application.

`app.describe()` gives a JSON-serializable graph, with the `from` of each declaration (the application that registered it): properties (name, flags, JSON Schema and `lineage`), blueprints, records and entities (fields, `options`, plugin descriptors), environments, repositories (entity, actions, `relations` and `environments` by name), use cases (`name`, `description`, `tags`, `deprecated`, `input`, `response`, optional `context`, `errors` as `{ kind: "exception", ref }` or `{ kind: "core", name }`, `dependencies` as `{ kind, ref }`, and `implementation`: `{ kind: "steps", steps }` or `{ kind: "opaque" }`) and exceptions (`layer` and, when declared as a string, `message`). A field is a reference by name (`{ kind: "entity", ref: "User" }`) when it holds a registered declaration. A property's `lineage` comes from `propertyLineageOf(Property)`: `Integer.with({ min: 0 })` is `{ kind: "refined", base, options }`, `optionalOf` is `{ kind: "optional", base }` and `enumOf` is `{ kind: "factory", factory: "enumOf", args: { values } }`. A root property (declared with `propertyOf`) has no lineage and is identified by its `name`; one with custom handlers is described with what is known (name and schema), never an error.

## Starting

`await app.start()` gets an application ready in one step, and gives it back:

1. It reads every environment it registers (its own and inherited ones) and reports all the variables that are missing or rejected at once: `InvalidApplicationEnvironment` (`Environment` layer, `details.environments`, e.g. `{ Database: ["DATABASE_URL"], Mail: ["FROM", "PORT"] }`, with the first `InvalidEnvironment` as its `cause`).
2. It makes the provider of `providerFrom`, if the application has one.
3. It checks that this provider runs the transactions of its commands (`InvalidCommandDeclaration` otherwise).

`start()` is idempotent: it gives the same promise until it fails (then it can be called again, e.g. once the variables are set) or `stop()` is called. `app.started` tells whether it completed. An application whose provider is an object, or that has none, works without `start()` as before; `start()` then only validates the environments.

**A provider made from the environment.** `providerFrom(environmentDependencies, create)` declares a provider that needs variables, such as a database URL, without reading them when the module loads:

```ts
import {
	applicationOf,
	blueprintOf,
	environmentOf,
	providerFrom,
} from "@afora/core";
import { drizzleProvider } from "@afora/drizzle";

const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.string })),
);

export const App = applicationOf({
	name: "blog",
	environments: { Database },
	repositories: { Users, Posts },
	provider: providerFrom(Database, (env) =>
		drizzleProvider({ db: connect(env.DATABASE_URL), tables }),
	),
	// ...
});

await App.start(); // validates Database, then calls create once
```

`environmentDependencies` is one environment or a list of distinct ones (merged in order), which must be registered in `environments` (`UnregisteredApplicationReference`); `create` gets their typed variables and gives a provider, or a promise of one. It is called once per start, by the first `start()` of the application or of one that extends it (they share the provider). Until then the repositories, use cases, commands and outputs of the application are bound as usual, to a provider that forwards each call to the one made on start; a call before `start()` throws `ApplicationNotStarted`. `isProviderFactory` tells a factory apart; `describe()` describes the provider as `{ kind: "opaque" }`.

`await app.stop()` calls the optional `close()` of the provider (a new optional member of `IRepositoryProvider`, for connections and files). With `providerFrom`, it also forgets the provider: calls throw `ApplicationNotStarted` again, and the next `start()` makes a new one.

## Named providers

An application can read and write through several providers, e.g. one database for the domain and another for an audit log. `providersOf` declares them by key, in a module of their own, so that repositories can name one before any application exists:

```ts
// providers.ts
import { providerFrom, providersOf } from "@afora/core";

export const Providers = providersOf({
	main: providerFrom(Database, (env) =>
		drizzleProvider({ db: connect(env.DATABASE_URL), tables }),
	),
	audit: providerFrom(Audit, (env) => auditProvider(env.AUDIT_URL)),
});

// repositories.ts
export const AuditLogs = repositoryOf({
	entity: AuditLog,
	actions: ["create"],
	provider: Providers.audit,
});

// application.ts
export const App = applicationOf({
	name: "blog",
	environments: { Database, Audit },
	providers: Providers,
	provider: Providers.main, // the repositories that name none
	repositories: { Users, Posts, AuditLogs },
});
```

`Providers.audit` (a `ProviderSlot`) completes in the editor and is renamed with its key. Each value is a provider or a factory of `providerFrom`; `providersOf` throws `InvalidApplicationDeclaration` for keys that are not identifiers (or are `inMemory`), for a value that is neither, and for one provider under two keys.

- **Each application makes its own.** An application that registers the storage makes its own instance of each `providerFrom` on `start()`, in the order of the keys after its default provider, and closes them all on `stop()` (a failed start closes those it made). Two applications that register one storage do not share data; an application that `extends` another, or is made by `.extend()`, shares its instances. A provider object (not a factory) is the same object for every application, as `provider: object` is.
- **Registered references.** A repository that names a provider of a storage the application does not register, and a `provider` that is not one of its `providers`, throw `UnregisteredApplicationReference` (`details.reference` is `provider "audit"`). The environments of each factory must be registered. Two storages with one key, through `extends`, throw `ApplicationConflict`.
- **Outside an application.** A repository on a provider object works as is. On a factory, a call throws `ProviderNotBound`: only an application makes it.
- **Transactions.** A transactional command must stay on one provider: repositories on two keys throw `InvalidCommandDeclaration` at declaration, and `start()` checks that each provider made runs the transactions of its commands.
- **Introspection.** `app.get(Providers.audit)` gives the instance of this application. `describe().providers` gives each key, with `from`, as a `ProviderDescription` (`opaque` for a factory), and a repository (or the application) on one has `provider: { kind: "ref", key: "audit" }`.
- **Import cycles.** The module of the storage must not import the repositories or the application that import it.

## The context of an application

`app.context` (an `ApplicationContext`) is what an application knows of itself: its `name`, `env(Environment)` for the typed variables of an environment it registers (one it does not register throws `UnregisteredApplicationReference`), and its `logger`. Your code reaches it through the application, or through `useApplication().context` without importing it.

The factories an application runs on start get it, so that a provider, or the log, is made from the variables without listing them up front:

```ts
import {
	applicationOf,
	jsonLogProvider,
	logFrom,
	providerFrom,
} from "@afora/core";

export const App = applicationOf({
	name: "blog",
	environments: { Database, Logging },
	log: logFrom((ctx) => ({
		level: ctx.env(Logging).LOG_LEVEL,
		providers: [jsonLogProvider()],
	})),
	provider: providerFrom((ctx) => {
		ctx.logger.info("connecting");
		return drizzleProvider({
			db: connect(ctx.env(Database).DATABASE_URL),
			tables,
		});
	}),
});
```

`providerFrom((ctx) => provider)` works as `providerFrom(environmentDependencies, create)`, but `create` gets the context instead of the merged variables. `start()` validates every environment first, then makes the log, then the provider. See [Logging](logging.md) for `log` and `logFrom`.

## The started application

`start()` also makes the application the started one of the process, which `useApplication()` gives from anywhere, without importing it. A hand-written use case or handler that the application itself imports can reach the application this way without an import cycle.

```ts
import { useApplication } from "@afora/core";

export async function notifyAll() {
	const app = useApplication(); // throws ApplicationNotStarted before start()
	const users = await app.get(Users).findMany();
	await app.get(Mailer).run("notify", { to: users.map((user) => user.email) });
}
```

`useApplication()` is typed by augmenting the `Register` interface once in the project, in a file of your own (codegen does not write it, so that two generated applications in one project do not conflict):

```ts
import type { App } from "./domain";

declare module "@afora/core" {
	interface Register {
		application: typeof App;
	}
}
```

Without it, `useApplication()` gives `AnyApplication` (`RegisteredApplication` is the type it gives).

- **One per process.** Starting another application while one is started throws `ApplicationAlreadyStarted` (`details: { current, attempted }`); starting the same one again is a no-op. `start({ replace: true })` stops the started one (calling its `stop()`) and takes its place, e.g. on hot reload, and `start({ register: false })` starts without registering, e.g. for a second application in tests. `stop()` unregisters it, and `resetApplication()` forgets the started application without stopping it, between tests.
- **Shared by copies of the package.** The started application is kept on `globalThis` under `Symbol.for("afora.application")`, so two copies of `@afora/core` loaded in one process (a duplicated module, a dual package) see the same one. It works on Bun, Node, browsers and Workers.
- **`app.get(declaration)`.** The bound repository, use case, command or output of a registered declaration (what `repository`, `useCase`, `command` and `output` give), or the variables of a registered environment (`app.get(Mail).FROM`). Anything else throws `InvalidApplicationDeclaration`.
