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

A use case is a class, and `execute` takes its dependencies as parameters with defaults, so a test replaces what it needs and leaves the rest. Build a new instance for each call: an instance runs once (`UseCaseAlreadyExecuted`).

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
});
```

An override is checked like the real thing: a name the use case does not declare, or the wrong kind of value, rejects with `InvalidUseCaseDependencies`, and a response that does not fit the blueprint is rejected too. Overrides apply to direct dependencies only.

Events collected by a use case are not run. Read them with `pullEvents()` on the instance, as for an entity.

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

Two services depend on the runtime and are worth fixing in tests. `configure({ hasher })` swaps the password hasher (a fast fake keeps tests quick, or supplies one on a Node without argon2), and `configure({ idGenerator })` makes ids predictable. `resetRuntime()` puts the defaults back; call it in `afterEach`.

```ts
import { afterEach, expect, test } from "bun:test";
import { blueprintOf, configure, entityOf, resetRuntime } from "@afora/core";

class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}

afterEach(() => resetRuntime());

test("ids are predictable", () => {
	configure({ idGenerator: () => "00000000-0000-7000-8000-000000000000" });

	expect(new Note({ title: "a" }).id).toBe(
		"00000000-0000-7000-8000-000000000000",
	);
});
```

## What `@afora/core/testing` has

| Export                 | For                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `memoryPublisher()`    | Testing an application: a publisher that keeps `{ topic, event }` in `published`.         |
| `providerContract`     | Writing a repository provider: the cases every `IRepositoryProvider` must pass.           |
| `httpProviderContract` | Writing an HTTP sink for a server (as `@afora/hono` and `@afora/fastify` are): its cases. |

The last two are tools for authors of packages. `providerContract({ describe, it, expect }, () => myProvider())` takes the functions of your test runner and a factory of fresh providers, and checks inserts, queries, unique keys, soft deletion, transactions, cursors and more; the [custom provider recipe](recipes/custom-provider.md) runs it. An application does not need them.
