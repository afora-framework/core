# Applications

`applicationOf` gathers the declarations of an app in one named, immutable manifest, so everything runs in one context and can be inspected:

```ts
import {
	applicationOf,
	blueprintOf,
	entityOf,
	enumOf,
	environmentOf,
	Integer,
	inMemoryProvider,
	repositoryOf,
} from "@afora/core";

const Age = Integer.with({ min: 0 });
const Status = enumOf(["draft", "published"]);
const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
class User extends entityOf(
	blueprintOf((ctx) => ({ email: ctx.email, age: Age, address: Address })),
	{ unique: ["email"] },
) {}
class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, status: Status, author: User })),
) {}
const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.string })),
);
const Users = repositoryOf({ entity: User, actions: ["findMany", "create"] });
const Posts = repositoryOf({
	entity: Post,
	actions: ["findMany", "create"],
	relations: [Users],
});

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

Use cases are registered by name too: `useCases: { Register, CreateUser }` (concrete classes, keyed by their `useCaseName`) and `exceptions: { UserAlreadyExists }` (made by `exceptionOf`, keyed by their `name`); another key throws `InvalidApplicationDeclaration`. The resolved set (extended applications included) is checked: every dependency of a use case must be registered, a use case, repository or environment, or given, a service in `services` (`UnregisteredUseCaseDependency`, with `details.useCase` and `details.dependency`); records and entities held by its `blueprint`, `response` or `context` must be registered (`UnregisteredApplicationReference`); and each class in `errors` must be in `exceptions`, unless it is an exception exported by `@afora/core` such as `RepositoryUniqueViolation` (`UnregisteredApplicationReference` otherwise).

With a `provider`, `providers`, `log`, `trace`, `runtime`, `publishers` or `services`, `app.useCases.Register` is a subclass of `Register` whose `dependencies` swap each repository for the application's bound one, through child use cases too; it is the same subclass every time, and `Register` itself is never changed. Without any of them, `app.useCases.Register === Register`. `app.useCase(Register)` gives the same class from the original, as `app.repository(Users)` does. So a use case that must read and write through the application runs as `new app.useCases.Register(input).execute()`, with no override, or in one call as `await app.run(Register, input)`; `new Register(input).execute()` on the module-level class reaches the module-level repositories, which throw `RepositoryUsedOutsideApplication` once an application bound them (see below), unless `execute` is given the application's (`execute({ users: app.repositories.Users })`).

`app.run(UseCase, input, options?)` builds the bound use case and executes it, returning its response: `options.context` is the context of the use case (required when it declares one), `options.dependencies` is what its `execute` takes to replace dependencies, and `options.replace` replaces declarations at any depth, as the static `run` of a use case does (see [Use cases](use-cases.md#run-and-replace)); a replacement names the declared repository or use case, and also replaces the bound one. The input may be left out when none of its keys is required. It always rejects rather than throws: with `InvalidApplicationDeclaration` for a use case that is not registered, and with what the constructor (invalid input or context) or `execute` raise. The events the use case collected are not handled, since the instance is not returned; a [command](commands.md) is what dispatches them, and `new app.useCases.Register(input)` gives the instance to call `pullEvents()` on.

Commands are registered the same way (`commands: { Users }`, keyed by `commandName`); when the use cases are bound, `app.commands.Users` runs over the bound ones (see [Commands](commands.md)). `publishers: { realtime: hub }` declares where event policies such as `publishEvents` publish, by key, inherited by the applications that extend it; a command whose policy names a key the application lacks throws `UnregisteredApplicationReference` (see [Event policies](commands.md#event-policies)). `services: { cache: (scope) => makeCache(scope) }` gives the value of each service its use cases declare with `serviceOf`, by name, made once per call from the context, the principal, the logger, the environments and the native request of the call; it is inherited the same way, and a use case that declares a service the application does not give throws `UnregisteredUseCaseDependency` (see [Services](use-cases.md#services)). A use case a command holds needs no listing, whether written by hand or made by a use case plugin (`ctx.create(Posts)`, see [Use cases](use-cases.md#plugins)): the commands that hold it register it under its `useCaseName`, with the checks of any other use case, so its dependencies must be registered and two different use cases with one name throw `ApplicationConflict` (give one a `name`); listing it in `useCases` too is valid. A use case registered only through a command is not in the type of `app.useCases`; reach the class as `app.commands.Blog.useCases.create`. `describe()` gives it `generic: { name, version, repository, options }` beside its `implementation`, the plugin, the registered repository and the options, with classes among them by name.

Outputs are registered with `outputs: { Api }`, keyed by `outputName` (`InvalidApplicationDeclaration`, which also rejects unnamed outputs made by `.pipe`); every command of an output must be registered in `commands` (`UnregisteredApplicationReference`, `details: { output, command }`). When the commands are bound, `app.outputs.Api` (or `app.output(Api)`) is the output rebuilt over the application-bound commands, with the same name, statuses and stages, memoized, so `invoke` on its operations writes through the application provider. `app.describe().outputs` gives, for each output, `from`, `name`, `commands` (names), `statuses` and `pipe`: each stage as `{ kind: "transform" | "sink", name, options }` (plus `hooks: true` for a sink given hooks, which are code), or `{ kind: "opaque" }` for a hand-written stage.

Repositories are module-level and may be shared, so an application does not change them: `app.repositories.Users` shares the declaration of `Users` but reads and writes through the `provider` of the application (or of the last application it extends that has one), unless `Users` declared its own. Two applications with different providers do not share data. Once an application binds `Users`, the module-level `Users` would read another store, so its methods throw `RepositoryUsedOutsideApplication` instead, pointing to `app.repositories.Users`, `app.run` and `execute` (see [Repositories](repositories.md)). Without a `provider`, `app.repositories.Users` is `Users` itself, nothing is bound, and records, entities and repositories work the same outside any application; with only a `runtime`, it is a copy that runs with those services, and `Users` stays usable, since both reach the same store.

`app.start()` also checks the provider it makes with `providerFrom`: when it does not read by cursor (`capabilities.keyset`) and a repository bound to it declares `findCursor`, it throws `InvalidApplicationDeclaration`, as it throws `InvalidCommandDeclaration` for a command whose transaction the provider cannot run.

`app.describe()` gives a JSON-serializable graph (typed `ApplicationDescription`, from `@afora/core/adapters`), with the `from` of each declaration (the application that registered it): properties (name, flags, JSON Schema and `lineage`), blueprints, records and entities (fields, `options`, plugin descriptors), environments, repositories (entity, actions, `relations` and `environments` by name), use cases (`name`, `description`, `tags`, `deprecated`, `input`, `response`, optional `context`, `errors` as `{ kind: "exception", ref }` or `{ kind: "core", name }`, `dependencies` as `{ kind, ref }`, and `implementation`: `{ kind: "steps", steps }` or `{ kind: "opaque" }`) and exceptions (`layer` and, when declared as a string, `message`). A field is a reference by name (`{ kind: "entity", ref: "User" }`) when it holds a registered declaration. A property's `lineage` comes from `propertyLineageOf(Property)` (from `@afora/core/experimental`): `Integer.with({ min: 0 })` is `{ kind: "refined", base, options }`, `optionalOf` is `{ kind: "optional", base }` and `enumOf` is `{ kind: "factory", factory: "enumOf", args: { values } }`. A root property (declared with `propertyOf`) has no lineage and is identified by its `name`; one with custom handlers is described with what is known (name and schema), never an error.

## Replacing registrations

`app.with({ repositories, useCases, environments, services, publishers })` gives a new application that extends `app`, with the registrations it names replaced by key, everywhere: in every use case at any depth, in the commands and outputs, in `app.repositories`, `context.env` and `get`. `app` is left as it is, and `extend()` keeps the replacements. It is meant for integration tests (see [Testing](testing.md#replacing-registrations)).

<!-- docs:code context
import {
	applicationOf,
	blueprintOf,
	entityOf,
	environmentOf,
	repositoryOf,
	serviceOf,
	useCaseOf,
} from "@afora/core";
const Amount = blueprintOf((ctx) => ({ amount: ctx.number }));
class Payment extends entityOf(Amount) {}
const Payments = repositoryOf({ entity: Payment, actions: ["create"] });
const Mail = environmentOf(
	blueprintOf((ctx) => ({ MAIL_TO: ctx.email })),
	{ source: () => ({ MAIL_TO: "team@example.com" }) },
);
const Mailer = serviceOf<{ send(to: string): void }>("mailer");
class Quote extends useCaseOf({
	name: "Quote",
	blueprint: Amount,
	response: blueprintOf((ctx) => ({ total: ctx.number })),
	dependencies: { mailer: Mailer },
}) {
	override async execute() {
		return { total: this.input.amount };
	}
}
const Blog = applicationOf({
	name: "blog",
	entities: { Payment },
	environments: { Mail },
	repositories: { Payments },
	useCases: { Quote },
	services: { mailer: () => ({ send: () => {} }) },
});
const fakeMailer = { send: (_to: string) => {} };
export { TestBlog };
-->
```ts
const TestBlog = Blog.with({
	services: { mailer: () => fakeMailer },
	environments: { Mail: { MAIL_TO: "editors@example.com" } },
	repositories: {
		Payments: {
			create: async () => {
				throw new Error("down");
			},
		},
	},
	useCases: { Quote: async ({ amount }) => ({ total: amount }) },
});
```

Each replacement is what that collection holds:

- **A repository** gets some of its methods; the others stay those of the repository, bound to the provider as before. Each method runs with the replacement as `this`. `app.repositories.Payments` (and `app.repository(Payments)`) shows them; the application still inspects, migrates and checks the real one.
- **A use case** gets a function of its input that gives its response, run in place of `execute` with the same checks: the input is validated before it, and the response after it (`InvalidUseCaseResponse`). Commands, outputs, `app.run` and the use cases that depend on it all reach it.
- **An environment** gets its variables, checked by its blueprint once, when `with` is called (`InvalidApplicationEnvironment`). The use cases, the factories of services, the commands (`command.env` and the `env` of event policies), the providers of its repositories (`context.env`), `app.context.env` and `app.get` read them, and `start()` does not load that environment.
- **A service** gets a factory and **a publisher** an `IEventPublisher`, as `services` and `publishers` take them.

The checks are those of `applicationOf`: a key the application does not register throws `UnregisteredApplicationReference` (`details: { holder: "app.with", reference: 'repository "Payments"' }`); a value of the wrong kind, a method the repository does not have, or a collection `with` does not replace throws `InvalidApplicationDeclaration`. A call that replaces something itself (`app.run(..., { replace })`, `execute(dependencies)`, `run(op, input, { env })` of a command) wins over `with` for that call. The new application has the name, provider, log, trace and runtime of `app`, so it shares its store, as an application made by `extend()` does: the same providers, those made by `providerFrom` included, so stopping it (`stop()`) stops them for `app` too. For a test, `testApplicationOf(app.with(...))` (see [Testing](testing.md#replacing-registrations)) is the isolated way: its application has a store of its own and stops only that. The settings of `with` are typed `ApplicationReplacementSettings`. `describe()` gives `replacements`, each one by collection and key as `{ kind: "opaque" }`; the declarations are described as they are.

## Runtime services

`runtime: { clock, idGenerator, hasher }` gives the application its own runtime services (see [Runtime](runtime.md#per-application-and-per-call)). Everything it runs uses them: its use cases (`app.run`, `app.useCases.X`), its commands and outputs, the entities they build and the passwords they hash, and its repositories, called through a use case or directly (`app.repositories.Items.create(...)`). A service it does not give falls back to `configure`, then to the default; `withRuntime` around a call comes before it. An application that extends it inherits them, its own winning each service, and `extend()` keeps them. Each service must be what `configure` takes (`InvalidApplicationDeclaration` otherwise).

What runs before any use case is not run by the application: the authenticator of a sink (the `jwt` of `hono()`, say) verifies a token, its `exp` and `nbf` included, before the use case is called, so it reads the clock of `withRuntime` around the request, or of `configure`, and not that of the application's `runtime`. A test that moves the application's clock past the expiry of a token sees the token still accepted; move the clock of `configure({ clock })` (or wrap the request in `withRuntime`) for that.

<!-- docs:code context
export {};
-->
```ts
import { applicationOf, blueprintOf, entityOf, useCaseOf } from "@afora/core";
import { manualClock } from "@afora/core/testing";

const Note = blueprintOf((ctx) => ({ title: ctx.string }));
class Item extends entityOf(Note) {}

class AddItem extends useCaseOf({
	name: "AddItem",
	blueprint: Note,
	response: blueprintOf(() => ({ item: Item })),
}) {
	override async execute() {
		return { item: new Item(this.input) };
	}
}

let next = 0;
const app = applicationOf({
	name: "Notes",
	entities: { Item },
	useCases: { AddItem },
	runtime: {
		clock: manualClock("2030-01-01T00:00:00.000Z"),
		idGenerator: () =>
			`01890000-0000-7000-8000-${String(++next).padStart(12, "0")}`,
	},
});

const { item } = await app.run(AddItem, { title: "a" });
item.id; // "01890000-0000-7000-8000-000000000001"
item.createdAt; // "2030-01-01T00:00:00.000Z"
```

The services travel with the call, not through the process, so two applications with different services can run at the same time, in one test or one server. Code the application does not run (an entity built in a test, outside any use case) keeps the services of `configure`. `describe().runtime` names each service given as `{ kind: "opaque" }`, as it does a `trace`.

## Starting

`await app.start()` gets an application ready in one step, and gives it back:

1. It reads every environment it registers (its own and inherited ones) and reports all the variables that are missing or rejected at once: `InvalidApplicationEnvironment` (`Environment` layer, `details.environments`, e.g. `{ Database: ["DATABASE_URL"], Mail: ["FROM", "PORT"] }`, with the first `InvalidEnvironment` as its `cause`).
2. It makes the provider of `providerFrom`, if the application has one.
3. It checks that this provider runs the transactions of its commands (`InvalidCommandDeclaration` otherwise).

`start()` is idempotent: it gives the same promise until it fails (then it can be called again, e.g. once the variables are set) or `stop()` is called. `app.started` tells whether it completed. An application whose provider is an object, or that has none, works without `start()` as before; `start()` then only validates the environments.

**A provider made from the environment.** `providerFrom(environmentDependencies, create)` declares a provider that needs variables, such as a database URL, without reading them when the module loads:

With the domain of the first example (`Database` is the environment declared there, `environmentOf(blueprintOf((ctx) => ({ DATABASE_URL: ctx.string })))`):

<!-- docs:code continue -->
```ts
import { providerFrom } from "@afora/core";
import { type DrizzleProviderOptions, drizzleProvider } from "@afora/drizzle";

declare const tables: DrizzleProviderOptions["tables"]; // your Drizzle tables
declare function connect(url: string): DrizzleProviderOptions["db"]; // your driver

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

<!-- docs:code continue -->
```ts
// providers.ts
import { providersOf } from "@afora/core";
import type { IRepositoryProvider } from "@afora/core/adapters";

const Audit = environmentOf(blueprintOf((ctx) => ({ AUDIT_URL: ctx.string })));
declare function auditProvider(url: string): IRepositoryProvider;

export const Providers = providersOf({
	main: providerFrom(Database, (env) =>
		drizzleProvider({ db: connect(env.DATABASE_URL), tables }),
	),
	audit: providerFrom(Audit, (env) => auditProvider(env.AUDIT_URL)),
});

// repositories.ts
class AuditLog extends entityOf(blueprintOf((ctx) => ({ action: ctx.text }))) {}
export const AuditLogs = repositoryOf({
	entity: AuditLog,
	actions: ["create"],
	provider: Providers.audit,
});

// application.ts
export const AuditedApp = applicationOf({
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
	blueprintOf,
	environmentOf,
	jsonLogProvider,
	logFrom,
	providerFrom,
} from "@afora/core";
import { type DrizzleProviderOptions, drizzleProvider } from "@afora/drizzle";

declare const tables: DrizzleProviderOptions["tables"];
declare function connect(url: string): DrizzleProviderOptions["db"];

const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.string })),
);
const Logging = environmentOf(
	blueprintOf((ctx) => ({
		LOG_LEVEL: ctx.enumOf(["debug", "info", "warn", "error"]),
	})),
);

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
import {
	blueprintOf,
	commandOf,
	entityOf,
	repositoryOf,
	useApplication,
	useCaseOf,
} from "@afora/core";

class User extends entityOf(blueprintOf((ctx) => ({ email: ctx.email }))) {}
const Users = repositoryOf({ entity: User, actions: ["findMany"] });
class Notify extends useCaseOf({
	name: "Notify",
	blueprint: blueprintOf((ctx) => ({ to: ctx.list.email })),
	response: blueprintOf(() => ({})),
}) {
	override async execute() {
		return {};
	}
}
const Mailer = commandOf({ name: "Mailer", useCases: { notify: Notify } });

export async function notifyAll() {
	const app = useApplication(); // throws ApplicationNotStarted before start()
	const users = await app.get(Users).findMany();
	await app.get(Mailer).run("notify", { to: users.map((user) => user.email) });
}
```

`useApplication()` is typed by augmenting the `Register` interface once in the project, in a file of your own (codegen does not write it, so that two generated applications in one project do not conflict):

<!-- docs:code file: domain/index.ts
import { applicationOf } from "@afora/core";

export const App = applicationOf({ name: "blog" });
-->

<!-- docs:code isolated -->
<!-- docs:code context
/* block */
import { useApplication } from "@afora/core";

const app: typeof App = useApplication();
-->
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
