# Standard Schema

Every field implements Standard Schema V1 (`vendor: "afora"`), so any library that takes one (Hono, tRPC, TanStack Form...) takes it as is. `validate` is synchronous, never throws for an invalid value, and reports every issue with its `path` (e.g. `["addresses", 0, "zip"]`).

| Field                                                              | `~standard.validate` gives                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| property class (`Slug`, `propertyOf`, `optionalOf(Property)`)      | the handled value: `Slug` turns `"Olá Mundo"` into `"ola-mundo"`                   |
| blueprint (and `optionalOf(blueprint)`, which accepts `undefined`) | the handled object, nested records as instances                                    |
| list (`listOf`)                                                    | a frozen array of the handled items                                                |
| record class (`recordOf`, subclasses included)                     | an instance of the class; a plain object for a nested record field becomes one too |

```ts
import { sValidator } from "@hono/standard-validator";
import { FieldApi, FormApi } from "@tanstack/form-core"; // see examples/interop for the full setup
import { initTRPC } from "@trpc/server";
import { Hono } from "hono";
import { blueprintOf, Email, listOf, recordOf } from "@afora/core";

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	slug: ctx.slug,
	addresses: listOf(Address),
}));
class User extends recordOf(UserBlueprint) {}

// Hono: `c.req.valid("json")` is the handled object; an invalid body is a 400 with the issues
new Hono().post("/users", sValidator("json", UserBlueprint), (c) =>
	c.json(c.req.valid("json")),
);

// tRPC: the resolver gets a `User`; an invalid input is `BAD_REQUEST`, its cause holding the issues
const t = initTRPC.create();
t.procedure.input(User).mutation(({ input }) => input.name);

// TanStack Form: a property validates a field, a blueprint validates the form
new FieldApi({ form, name: "email", validators: { onChange: Email } });
new FormApi({ defaultValues, validators: { onChange: UserBlueprint } });
```

Without a framework, `safeParse` (on properties, blueprints and record classes) takes `unknown` and returns `{ value }` or `{ issues }`, never both and never throwing for an invalid value:

```ts
const result = UserBlueprint.safeParse(body);
if (result.issues) {
	for (const issue of result.issues) {
		console.log(issue.path, issue.code, issue.message); // ["addresses", 0, "zip"] "invalid_value" ...
	}
} else {
	result.value; // handled and frozen
}
```

`code` is one of `required`, `invalid_type`, `invalid_value`, `undeclared_key`, `too_few_items`, `too_many_items` and `not_record`; `source` names who rejected the value, and for a property issue `cause` keeps the exception it raised. That exception is built the first time `cause` is read, so rejecting a value costs no exception until someone asks for one; `cause` is not among the keys of the issue (`Object.keys`, a spread and `JSON.stringify` leave it out).

**Payloads with more than you read.** A key the shape does not declare is rejected at any depth (`undeclared_key`), never trimmed, and that stays the rule. For a payload from another service that carries much more than the operation reads (a webhook from Stripe or GitHub), `stripUndeclared(shape, value)` gives a copy with only the declared keys, in nested blueprints, list items, `optionalOf` and records or entities held as fields, before parsing. `shape` is a blueprint, a record or entity class, or any field. It does not validate, never throws and does not change `value`: values of the wrong type, a property's value and record instances come back as they are, for parsing to judge.

```ts
const result = Customer.safeParse(
	stripUndeclared(Customer, stripeEvent.data.object),
);
```

The `webhooks` option of [`@afora/hono`](../packages/hono/README.md#webhooks) does this with `unknownKeys: "strip"`.

`Record.safeParse` builds the instance through the class constructor, so a subclass that normalizes its input, or throws its own exception, is honored: what `new User(value)` accepts, `User.safeParse(value)` accepts, and an error thrown by the constructor becomes an issue (code `invalid_value`, path `[]`) instead of escaping. An instance of the class is returned as it is. The constructor always runs, for any class (the one `recordOf` returns, a subclass with or without a constructor of its own, an entity), since only the constructor can tell what the record is. What `safeParse` saves is the exception of a value the record rejects: the record it is building hands its issues over without building the exception `new` throws for them, with its stack and its trace, which nobody would read. Records built by `new`, inside a constructor included, throw as they always do.

One case shows it: a constructor that wraps `super(...)` in its own `try`/`catch`. During a `safeParse`, what it catches for a rejected value stands in for the exception `new` would have thrown: `instanceof`, `name`, `message`, `details`, `trace`, `is(...)` and `toJSON()` answer as that exception, which is built the first time one of them is read, so a constructor that inspects, wraps or rethrows it behaves the same as under `new`. It is not that exception itself, though: its `stack` starts where it was first read, `Error.isError` and `structuredClone` do not take it for an error, and it is another object than the one a later `new` throws. The same holds for a record of the same class that a constructor builds by `new` before calling `super(...)`.

The input type is that of the blueprint (a record field takes an instance or a plain object). `StandardSchemaV1.InferOutput<typeof User>` is the instance type of the class `recordOf` returns. For a subclass that adds members (`class User extends recordOf(...) { get initials() {} }`) that is the base record instance type, because TypeScript cannot type the statics of a subclass; at runtime the value is an instance of the subclass, so narrow it with `instanceof User`. Each class has one stable `~standard` object.

The real-library tests (Hono, tRPC, TanStack Form) are in `examples/interop`: `bun run test:interop`.
