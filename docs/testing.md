# Testing an application

This page is about testing the code you write with afora: records, entities, use cases, an application and its HTTP API. The examples use `bun:test`; `vitest` and `jest` take the same `test` and `expect`. Nothing here needs a database, a server or a mock library, because the default provider keeps data in memory and an output is a function you can call. A test of an application starts with `testApplicationOf(App)` from `@afora/core/testing`: the application on an empty store of its own, stopped when the test ends ([An application and its API](#an-application-and-its-api)).

To test a repository **provider** you are writing, see [Testing a provider](repositories.md#testing-a-provider) and the last section of this page.

## Records and entities

A record is a plain class, so test it by building it. Check the normalized values, the masking of sensitive keys, and what `safeParse` reports for bad input. `safeParse` never throws; it gives `{ value }` or `{ issues }`, and each issue has a `code`, a `path` and a `message`.

```ts
import { expect, test } from "bun:test";
import { blueprintOf, MASK, recordOf } from "@afora/core";

const Account = recordOf(
	blueprintOf((ctx) => ({ email: ctx.email, token: ctx.string })),
	{ sensitive: ["token"] },
);

test("normalizes and masks", () => {
	const account = new Account({ email: " Ana@Example.com ", token: "secret" });

	expect(account.email).toBe("ana@example.com");
	expect(account.toJSON()).toEqual({ email: "ana@example.com", token: MASK });
});

test("rejects an undeclared key without throwing", () => {
	const result = Account.safeParse({
		email: "ana@example.com",
		token: "secret",
		extra: 1,
	});

	expect(result.issues?.map((issue) => issue.code)).toEqual(["undeclared_key"]);
});
```

`new Account(bad)` throws a `Record` exception instead (`InvalidRecordValue`, `UndeclaredRecordProperty`); test that with `expect(() => new Account(bad)).toThrow()`, or catch it and check `error.is(UndeclaredRecordProperty)`. Match on the class, the layer or the issue `code`, never on the message.

Domain events are testable without a command: build the entity, act on it, and read `pullEvents()`, which empties the queue.

```ts
import { expect, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	eventOf,
	type EventDefinition,
} from "@afora/core";

class Order extends entityOf(
	blueprintOf((ctx) => ({ item: ctx.text })),
	{ onCreate: () => OrderPlaced },
) {}
const OrderPlaced: EventDefinition = eventOf("order.placed", Order);

test("a new order queues order.placed", () => {
	const order = new Order({ item: "mug" });

	expect(order.pullEvents().map((event) => event.name)).toEqual([
		"order.placed",
	]);
	expect(order.pullEvents()).toEqual([]);
});
```

## Repositories

`inMemoryProvider()` is the default, so a repository works in a test as it is. It enforces the same rules as any provider: `RepositoryUniqueViolation`, soft deletion, cursors, transactions, versions. A repository declared at module level keeps its rows for the whole process, so give the repositories of a test block one provider and empty it before each test with `clear()`, which also starts the `Serial` ids again at 1 (`clear("Note")` or `clear(Note)` empties one entity):

```ts
import { beforeEach, expect, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	inMemoryProvider,
	repositoryOf,
	RepositoryUniqueViolation,
} from "@afora/core";

class Note extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ unique: ["title"] },
) {}
const store = inMemoryProvider();
const Notes = repositoryOf({
	entity: Note,
	actions: ["create", "findByTitle"],
	provider: store,
});

beforeEach(() => store.clear());

test("a title is unique", async () => {
	await Notes.create(new Note({ title: "a" }));

	const error = await Notes.create(new Note({ title: "a" })).catch(
		(caught) => caught,
	);

	expect(error).toBeInstanceOf(RepositoryUniqueViolation);
});

test("starts empty", async () => {
	expect(await Notes.findByTitle("a")).toBeUndefined();
});
```

`clear()` waits for a running transaction, and `spyProvider(inMemoryProvider())` has it too. Repositories that an application registers are tested through the application instead (below).

## Use cases

A use case is a class, and `execute` takes its dependencies as parameters with defaults, so a test replaces what it needs and leaves the rest. An instance runs once (`UseCaseAlreadyExecuted`): build a new one for each call, or call the static `run`, which does it for you (`Greet.run(input, { dependencies })`).

**Replace a use case dependency** with a function that returns the declared response. **Replace an environment** with an object of valid variables, which skips reading the real ones. **Replace a repository** with an object holding the methods the rule calls; the class types it as the whole repository, so write `satisfies Partial<typeof Repo> as typeof Repo`. The [recipe](recipes/override-repository-method.md) shows a repository, with the code run by the test suite of the docs.

```ts
import { expect, test } from "bun:test";
import { blueprintOf, environmentOf, useCaseOf } from "@afora/core";

const Settings = environmentOf(
	blueprintOf((ctx) => ({ GREETING: ctx.string })),
	{ source: () => ({ GREETING: "Hello" }) },
);

class Greet extends useCaseOf({
	name: "Greet",
	blueprint: blueprintOf((ctx) => ({ name: ctx.text })),
	response: blueprintOf((ctx) => ({ text: ctx.string })),
	dependencies: { settings: Settings },
}) {
	override async execute({ settings = this.dependencies.settings } = {}) {
		return { text: `${settings.GREETING}, ${this.input.name}` };
	}
}

test("uses the environment, or the one the test gives", async () => {
	expect((await new Greet({ name: "Ana" }).execute()).text).toBe("Hello, Ana");

	const replaced = await new Greet({ name: "Ana" }).execute({
		settings: { GREETING: "Oi" },
	});
	expect(replaced.text).toBe("Oi, Ana");

	// The same, without keeping an instance.
	const again = await Greet.run(
		{ name: "Bia" },
		{ dependencies: { settings: { GREETING: "Olá" } } },
	);
	expect(again.text).toBe("Olá, Bia");
});
```

An override is checked like the real thing: a name the use case does not declare, or the wrong kind of value, rejects with `InvalidUseCaseDependencies`, and a response that does not fit the blueprint is rejected too. Overrides apply to direct dependencies only.

**Replace a dependency further down** with `replace`, keyed by the declaration rather than by name: the real graph runs, and every use case of the call that declares it gets the replacement. A use case that calls another, which reads the environment, gets the replacement at the second level:

<!-- docs:code continue -->
```ts
class Welcome extends useCaseOf({
	name: "Welcome",
	blueprint: blueprintOf((ctx) => ({ name: ctx.text })),
	response: blueprintOf((ctx) => ({ text: ctx.string })),
	dependencies: { greet: Greet },
}) {
	override async execute({ greet = this.dependencies.greet } = {}) {
		return { text: `${(await greet(this.input)).text}!` };
	}
}

test("replaces the environment of a nested use case", async () => {
	const { text } = await Welcome.run(
		{ name: "Ana" },
		{ replace: [[Settings, { GREETING: "Oi" }]] },
	);
	expect(text).toBe("Oi, Ana!");
});
```

A replacement is checked like an override, and one that no use case of the call declares rejects with `UnusedUseCaseReplacement`, so a test does not keep passing after a dependency was renamed. `app.run`, `command.run` and `command.execute` take the same `replace`. See [Use cases](use-cases.md#run-and-replace).

Events collected by a use case are not run. Read them with `pullEvents()` on the instance, as for an entity, or get them with the response from `run(input, { events: true })`, which gives `{ value, events }`.

For a command, `run(operation, input, { env })` replaces environment variables for that call only, and `execute` gives `{ value, events }` without running an event policy. See [Commands](commands.md#environments).

## An application and its API

An application runs everything in one context. In a test, run it through `testApplicationOf(App, options?)` from `@afora/core/testing`. It gives an application that extends `App` (its declarations, log, services, publishers, runtime and `app.with` replacements) with:

- **a store of its own**: every repository reads and writes through a new `inMemoryProvider()`, whatever provider it declares: the `provider` of the application (also one of `providerFrom`, which is never made), those of `providersOf` and one a repository names itself. So no row is shared with another test, and the test needs no database. `options.provider` gives another one, such as a [spy](#spying-on-the-database); `app.provider` is the one it uses, so `await app.provider.clear()` empties it in the middle of a test.
- **already started**, without becoming the application of the process (`useApplication`), so tests that run at the same time do not take each other's place.
- **`Symbol.asyncDispose`**, which stops it: with `await using`, the application stops when the test ends, also when an assertion throws before the end.
- `options.seed(app)`, run once it has started, to insert fixtures through `app.repositories` or `app.run`. When `seed` throws, the application is stopped and `testApplicationOf` rejects with that error.
- `options.runtime`, the [runtime services](#runtime-services) of the application, over those of `App`.

Its type is `TestApplication<typeof App>`: `App`, with `provider` typed as the one given (`InMemoryProvider` by default); the options are `TestApplicationOptions`.

An output built by the `hono` sink is a Hono app, whose `request(path, init)` calls the API without a socket. That is how the [tutorial](tutorial.md) is tested.

```ts
import { expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
import { testApplicationOf } from "@afora/core/testing";
import { hono } from "@afora/hono";

class Note extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ unique: ["title"], change: ["title"] },
) {}
const Notes = repositoryOf({
	entity: Note,
	actions: ["findById", "findPage", "create", "update", "delete"],
});
const Notebook = commandOf({
	name: "Notebook",
	useCases: resourceOf(Notes, { path: "/notes" }),
});
const Api = outputOf({ name: "Api", commands: [Notebook], pipe: [hono()] });

// The application as it ships: the tests give it its store
const App = applicationOf({
	name: "notes",
	entities: { Note },
	repositories: { Notes },
	commands: { Notebook },
	outputs: { Api },
});

const post = (app: typeof App, path: string, body: unknown) =>
	app.outputs.Api.build().request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

test("creates a note, then refuses a duplicate with 409", async () => {
	await using app = await testApplicationOf(App);

	expect((await post(app, "/notes", { title: "a" })).status).toBe(201);
	expect((await post(app, "/notes", { title: "a" })).status).toBe(409);
	expect((await post(app, "/notes", { title: "b", extra: 1 })).status).toBe(
		400,
	);
});

test("starts with the notes of seed, and no other", async () => {
	await using app = await testApplicationOf(App, {
		seed: (app) => app.repositories.Notes.create(new Note({ title: "a" })),
	});

	const page = await app.repositories.Notes.findPage();
	expect(page.items.map((note) => note.title)).toEqual(["a"]);
});
```

The `statusOf` rules turn exceptions into statuses (400 for invalid input, 401, 403, 404, 409, 500); a test asserts the status and, for a problem, the `type` (`urn:afora:exception:<name>`) of the body. See [Outputs](outputs.md).

To test as a signed-in caller, send the credentials the sink is configured for (a bearer token for `jwt`); to test a use case's rule without HTTP, call `app.run(UseCase, input, { context })`. See [Access](auth.md).

`await using` needs TypeScript 5.2 or later with `esnext.disposable` (or `ESNext`) in `lib`, and a runtime that has `Symbol.asyncDispose` (Bun, Node 22). Without it, write `const app = await testApplicationOf(App)` and `await app.stop()` in a `finally` or an `afterEach`.

**Strict mode.** A repository the application does not register still writes to a store of the process, which outlives the test: a use case that imports one directly, or a test that calls the module-level repository. With `testApplicationOf(App, { strict: true })`, while that application runs, a write (`create`, `update`, `delete`, `restore`, `increment`) through a repository no application bound throws `RepositoryWrittenOutsideApplication` (layer `repository`) naming the application; reads are left alone. The check is for the whole process, so a strict test also stops those writes in tests that run at the same time. A repository an application did bind already throws `RepositoryUsedOutsideApplication` when called at module level (see [Repositories](repositories.md)).

### Replacing registrations

An integration test often needs the application as it is, with a few things swapped: a mailer that sends nothing, an environment with fixed variables, a repository that fails. `app.with` gives that application without declaring a second one: the registrations it names are replaced by key, in every use case at any depth and in the commands and outputs, so the real sink, statuses, auth and event policies run (see [Applications](applications.md#replacing-registrations)). `testApplicationOf` takes the application `with` gives, and keeps its replacements over its own store.

<!-- docs:code context
import { expect, test } from "bun:test";
import type { AnyApplication } from "@afora/core";
import { testApplicationOf } from "@afora/core/testing";
declare const Blog: AnyApplication;
-->
```ts
test("publishes and mails the editors", async () => {
	const sent: string[] = [];
	await using app = await testApplicationOf(
		Blog.with({
			services: {
				mailer: () => ({
					send: (to: string, text: string) => {
						sent.push(`${to}: ${text}`);
						return `sent to ${to}`;
					},
				}),
			},
			environments: { Mail: { MAIL_TO: "editors@example.com" } },
			repositories: { Posts: { findMany: async () => [] } },
		}),
	);

	const response = await app.outputs.Api.build().request("/posts/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Hello" }),
	});
	expect(response.status).toBe(200);
	expect(sent).toEqual(["editors@example.com: Hello"]);
});
```

A repository replacement gives only the methods the test changes; the others still read and write through the provider. A use case is replaced by a function of its input, whose response is checked as that of `execute` is. An environment replacement is checked by its blueprint when `with` is called, and `start()` does not ask the process for those variables. A key the application does not register throws `UnregisteredApplicationReference`, and a value of the wrong kind `InvalidApplicationDeclaration`, so a renamed registration does not leave a test passing against the real one. `Blog` itself is not changed.

## Spying on the database

A repository is frozen: patching one of its methods fails, because the object cannot be changed. That is on purpose. Assigning a method (`Projects.findMany = ...`, which is what a spy that assigns does) throws `RepositoryIsFrozen`, whose message names `spyProvider`, `execute` and this section. A spy that redefines the property (`vi.spyOn`, `jest.spyOn`) is stopped by the engine before afora is asked, with `TypeError: Cannot redefine property: findMany`, or `Cannot define property findMany, object is not extensible`; `spyOn` of `bun:test` reports `spyOn(target, prop) does not support accessor properties yet`. Whichever message you got, the answer is the same. One repository is shared by every use case, command and application that names it, so a patched method would leak into every other test of the process; and an application with a `provider` does not even call it, since `app.repositories.Projects` is a copy bound to that provider. Spy on what lies under every repository instead: the provider.

**Behind an HTTP sink**, where the test sends a request and never calls `execute`, wrap the provider with `spyProvider` from `@afora/core/testing` and give it to the application, as `testApplicationOf(App, { provider: spy })`. The spy is the provider itself, plus three members:

- `calls(entity?, operation?)` gives the calls recorded so far, in order, as `{ operation, entity, args }`: `entity` is the name of the entity (`recordNameOf`, the `name` option when it has one), and the filter takes that name or the class; `operation` is one of the operations of [`wrapProvider`](repositories.md#wrapping-a-provider) (`findOne`, `findMany`, `insert`, `update`, `remove`, `count`, `increment`, `migrate`). The calls inside a transaction are recorded too.
- `fail(entity, operation, error, { times })` makes that operation reject with `error` instead of reaching the provider: the next `times` calls, or every call until `reset()`. The call is still recorded. It throws `InvalidRepositoryDeclaration` when `times` is not a positive integer, or when the provider has no such operation (an `increment` on a provider without one would never fail).
- `reset()` forgets the calls and the failures.

A provider that already has a `calls`, `fail` or `reset` member is refused (`InvalidRepositoryDeclaration`), since the spy would hide it.

```ts
import { expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	ExceptionLayers,
	exceptionOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { spyProvider, testApplicationOf } from "@afora/core/testing";
import { hono } from "@afora/hono";

class Setting extends entityOf(blueprintOf((ctx) => ({ key: ctx.string }))) {}
const Settings = repositoryOf({ entity: Setting, actions: ["count"] });
const StoreDown = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "StoreDown",
	message: "The store is down.",
});

class CountSettings extends useCaseOf({
	name: "CountSettings",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ total: ctx.integer })),
	dependencies: { Settings },
	route: { method: "get", path: "/settings/count" },
}) {
	override async execute({ Settings = this.dependencies.Settings } = {}) {
		return { total: await Settings.count() };
	}
}
const Admin = commandOf({ name: "Admin", useCases: { count: CountSettings } });
const Api = outputOf({
	name: "Api",
	commands: [Admin],
	statuses: { StoreDown: 503 },
	pipe: [hono()],
});

const Cms = applicationOf({
	name: "cms",
	entities: { Setting },
	repositories: { Settings },
	useCases: { CountSettings },
	commands: { Admin },
	outputs: { Api },
});

test("a failing count is a 503", async () => {
	const spy = spyProvider(inMemoryProvider());
	await using app = await testApplicationOf(Cms, { provider: spy });
	const api = app.outputs.Api.build();

	expect((await api.request("/settings/count")).status).toBe(200);
	expect(spy.calls("Setting", "count")).toHaveLength(1);

	spy.fail(Setting, "count", new StoreDown({ source: "test" }));
	expect((await api.request("/settings/count")).status).toBe(503);
});
```

Inject a declared exception (`exceptionOf`) and map its name in the output `statuses`. A plain `Error` crosses the repository as `UnexpectedError`: it is a 500, and its message stays masked in the response.

**With a direct call**, you need no spy: a use case takes its repositories as parameters of `execute`, so the test passes an object with the methods it wants to count or to fail (see [Use cases](#use-cases) and the [recipe](recipes/override-repository-method.md)).

<!-- docs:code continue -->
```ts
test("counts through the repository it is given", async () => {
	let reads = 0;
	const result = await new CountSettings({}).execute({
		Settings: {
			count: async () => {
				reads += 1;
				return 3;
			},
		} satisfies Partial<typeof Settings> as typeof Settings,
	});

	expect(result.total).toBe(3);
	expect(reads).toBe(1);
});
```

## Events and publishers

`memoryPublisher()` from `@afora/core/testing` is a publisher that keeps what it is given. Register it under the key your `publishEvents` policy names, run the command, and read `published`, a list of `{ topic, event }`. `clear()` forgets it.

```ts
import { expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EventDefinition,
	entityOf,
	eventOf,
	publishEvents,
	repositoryOf,
} from "@afora/core";
import { memoryPublisher, testApplicationOf } from "@afora/core/testing";

class Order extends entityOf(
	blueprintOf((ctx) => ({ item: ctx.text })),
	{ onCreate: () => OrderPlaced },
) {}
const OrderPlaced: EventDefinition = eventOf("order.placed", Order);
const Orders = repositoryOf({ entity: Order, actions: ["create"] });
const Shop = commandOf({
	name: "Shop",
	useCases: (ctx) => ({ place: ctx.create(Orders) }),
	events: publishEvents({ publisher: "bus", topic: "{event}" }),
});

test("publishes order.placed after the call", async () => {
	const bus = memoryPublisher();
	await using app = await testApplicationOf(
		applicationOf({
			name: "shop",
			entities: { Order },
			repositories: { Orders },
			commands: { Shop },
			publishers: { bus },
		}),
	);

	await app.commands.Shop.run("place", { item: "mug" });

	expect(bus.published.map((entry) => entry.topic)).toEqual(["order.placed"]);
});
```

## Runtime services

Three services depend on the runtime and are worth fixing in tests: the password hasher (a fast fake keeps tests quick, or supplies one on a Node without argon2), the id generator (predictable ids) and the clock (time the test moves, with `manualClock()` of `@afora/core/testing`, see [Time](runtime.md#time), instead of patching `Date` for the whole process).

Give them to the application under test, with `runtime`. They then belong to that application and to nothing else, so tests that run at the same time (`test.concurrent`, a runner that shares modules between files, two applications in one file) do not see each other's services, and nothing has to be reset after the test:

```ts
import { expect, test } from "bun:test";
import { applicationOf, blueprintOf, entityOf, useCaseOf } from "@afora/core";
import { manualClock } from "@afora/core/testing";

const Title = blueprintOf((ctx) => ({ title: ctx.text }));
class Note extends entityOf(Title) {}

class AddNote extends useCaseOf({
	name: "AddNote",
	blueprint: Title,
	response: blueprintOf(() => ({ note: Note })),
}) {
	override async execute() {
		return { note: new Note(this.input) };
	}
}

const appWith = (start: string) =>
	applicationOf({
		name: "Notes",
		entities: { Note },
		useCases: { AddNote },
		runtime: {
			clock: manualClock(start),
			idGenerator: () => "00000000-0000-7000-8000-000000000000",
		},
	});

test.concurrent("stamps with its own clock", async () => {
	const app = appWith("2030-01-01T00:00:00.000Z");
	const { note } = await app.run(AddNote, { title: "a" });

	expect(note.id).toBe("00000000-0000-7000-8000-000000000000");
	expect(note.createdAt).toBe("2030-01-01T00:00:00.000Z");
});
```

`testApplicationOf(App, { runtime })` gives them to the test application the same way, over those of `App`. For code outside an application (an entity or a password built in the test itself), `withRuntime(services, fn)` gives the services to what `fn` runs, and to nothing after it returns (see [Runtime](runtime.md#per-application-and-per-call)). `configure` still works, but it sets the services of the whole process: a test that calls it must call `resetRuntime()` in `afterEach`, and tests that run at the same time share what it set.

## What `@afora/core/testing` has

| Export                             | For                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `testApplicationOf(app, options?)` | Testing an application: `app` on a store of its own, started, `seed`ed, stopped by `await using`; `strict` catches writes through unbound repositories.      |
| `memoryPublisher()`                | Testing an application: a publisher that keeps `{ topic, event }` in `published`.                                                                            |
| `manualClock(start?)`              | Testing time: a clock for `runtime`, `withRuntime` or `configure({ clock })` with `now()`, `set(date \| ms \| iso)` and `advance(ms \| { minutes, days… })`. |
| `spyProvider()`                    | Testing an application: a provider that records its calls and fails on demand.                                                                               |
| `providerContract`                 | Writing a repository provider: the cases every `IRepositoryProvider` must pass.                                                                              |
| `httpProviderContract`             | Writing an HTTP sink for a server (as `@afora/hono` and `@afora/fastify` are): its cases.                                                                    |

The last two are tools for authors of packages. `providerContract({ describe, it, expect }, () => myProvider())` takes the functions of your test runner and a factory of fresh providers, and checks inserts, queries, unique keys, soft deletion, transactions, cursors and more; the [custom provider recipe](recipes/custom-provider.md) runs it. An application does not need them.
