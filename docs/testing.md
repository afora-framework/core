# Testing an application

This page is about testing the code you write with afora: records, entities, use cases, an application and its HTTP API. The examples use `bun:test`; `vitest` and `jest` take the same `test` and `expect`. Nothing here needs a database, a server or a mock library, because the default provider keeps data in memory and an output is a function you can call.

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

`inMemoryProvider()` is the default, so a repository works in a test as it is. It enforces the same rules as any provider: `RepositoryUniqueViolation`, soft deletion, cursors, transactions, versions. Declare repositories in a function when each test needs an empty one, because a module-level repository keeps its rows for the whole process:

```ts
import { expect, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	repositoryOf,
	RepositoryUniqueViolation,
} from "@afora/core";

class Note extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ unique: ["title"] },
) {}
const makeNotes = () =>
	repositoryOf({ entity: Note, actions: ["create", "findByTitle"] });

test("a title is unique", async () => {
	const Notes = makeNotes();
	await Notes.create({ title: "a" });

	const error = await Notes.create({ title: "a" }).catch((caught) => caught);

	expect(error).toBeInstanceOf(RepositoryUniqueViolation);
	expect(await makeNotes().findByTitle("a")).toBeUndefined();
});
```

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

An application runs everything in one context. In a test, give it its own `inMemoryProvider()` so each test starts with empty repositories, start it, and stop it afterwards. Without a `provider`, `app.repositories.X` is the module-level repository, and its rows are shared between applications.

An output built by the `hono` sink is a Hono app, whose `request(path, init)` calls the API without a socket. That is how the [tutorial](tutorial.md) is tested.

```ts
import { expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
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

// One application per test: its provider is empty
const newApp = () =>
	applicationOf({
		name: "notes",
		entities: { Note },
		repositories: { Notes },
		commands: { Notebook },
		outputs: { Api },
		provider: inMemoryProvider(),
	});

const send = (app: ReturnType<typeof newApp>, path: string, body?: unknown) =>
	app.outputs.Api.build().request(path, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

test("creates a note, then refuses a duplicate with 409", async () => {
	const app = newApp();
	await app.start({ replace: true });

	expect((await send(app, "/notes", { title: "a" })).status).toBe(201);
	expect((await send(app, "/notes", { title: "a" })).status).toBe(409);
	expect((await send(app, "/notes", { title: "b", extra: 1 })).status).toBe(
		400,
	);

	await app.stop();
});
```

`start({ replace: true })` takes the place of an application that a previous test left started, and `stop()` releases what the provider holds. The `statusOf` rules turn exceptions into statuses (400 for invalid input, 401, 403, 404, 409, 500); a test asserts the status and, for a problem, the `type` (`urn:afora:exception:<name>`) of the body. See [Outputs](outputs.md).

To test as a signed-in caller, send the credentials the sink is configured for (a bearer token for `jwt`); to test a use case's rule without HTTP, call `app.run(UseCase, input, { context })`. See [Access](auth.md).

## Spying on the database

A repository is frozen: patching one of its methods fails, because the object cannot be changed. That is on purpose. Assigning a method (`Projects.findMany = ...`, which is what a spy that assigns does) throws `RepositoryIsFrozen`, whose message names `spyProvider`, `execute` and this section. A spy that redefines the property (`vi.spyOn`, `jest.spyOn`) is stopped by the engine before afora is asked, with `TypeError: Cannot redefine property: findMany`, or `Cannot define property findMany, object is not extensible`; `spyOn` of `bun:test` reports `spyOn(target, prop) does not support accessor properties yet`. Whichever message you got, the answer is the same. One repository is shared by every use case, command and application that names it, so a patched method would leak into every other test of the process; and an application with a `provider` does not even call it, since `app.repositories.Projects` is a copy bound to that provider. Spy on what lies under every repository instead: the provider.

**Behind an HTTP sink**, where the test sends a request and never calls `execute`, wrap the provider with `spyProvider` from `@afora/core/testing` and give it to the application. The spy is the provider itself, plus three members:

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
import { spyProvider } from "@afora/core/testing";
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

test("a failing count is a 503", async () => {
	const spy = spyProvider(inMemoryProvider());
	const app = applicationOf({
		name: "cms",
		entities: { Setting },
		repositories: { Settings },
		useCases: { CountSettings },
		commands: { Admin },
		outputs: { Api },
		provider: spy,
	});
	await app.start({ replace: true });
	const api = app.outputs.Api.build();

	expect((await api.request("/settings/count")).status).toBe(200);
	expect(spy.calls("Setting", "count")).toHaveLength(1);

	spy.fail(Setting, "count", new StoreDown({ source: "test" }));
	expect((await api.request("/settings/count")).status).toBe(503);

	await app.stop();
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
import { memoryPublisher } from "@afora/core/testing";

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
	const app = applicationOf({
		name: "shop",
		entities: { Order },
		repositories: { Orders },
		commands: { Shop },
		publishers: { bus },
	});
	await app.start({ replace: true });

	await app.commands.Shop.run("place", { item: "mug" });

	expect(bus.published.map((entry) => entry.topic)).toEqual(["order.placed"]);
	await app.stop();
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

For code outside an application (an entity or a password built in the test itself), `withRuntime(services, fn)` gives the services to what `fn` runs, and to nothing after it returns (see [Runtime](runtime.md#per-application-and-per-call)). `configure` still works, but it sets the services of the whole process: a test that calls it must call `resetRuntime()` in `afterEach`, and tests that run at the same time share what it set.

## What `@afora/core/testing` has

| Export                 | For                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memoryPublisher()`    | Testing an application: a publisher that keeps `{ topic, event }` in `published`.                                                                            |
| `manualClock(start?)`  | Testing time: a clock for `runtime`, `withRuntime` or `configure({ clock })` with `now()`, `set(date \| ms \| iso)` and `advance(ms \| { minutes, days… })`. |
| `spyProvider()`        | Testing an application: a provider that records its calls and fails on demand.                                                                               |
| `providerContract`     | Writing a repository provider: the cases every `IRepositoryProvider` must pass.                                                                              |
| `httpProviderContract` | Writing an HTTP sink for a server (as `@afora/hono` and `@afora/fastify` are): its cases.                                                                    |

The last two are tools for authors of packages. `providerContract({ describe, it, expect }, () => myProvider())` takes the functions of your test runner and a factory of fresh providers, and checks inserts, queries, unique keys, soft deletion, transactions, cursors and more; the [custom provider recipe](recipes/custom-provider.md) runs it. An application does not need them.
