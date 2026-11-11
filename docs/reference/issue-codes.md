# Issue codes

`safeParse` (on properties, blueprints, lists and record classes) and `~standard.validate` never throw for an invalid value: they return every issue they find. Each issue is an `Issue`, a Standard Schema issue with three more keys:

| Key       | What it holds                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `code`    | Why the value was rejected: one of the codes below (`IssueCode`).                                                  |
| `path`    | Where: the keys and list indexes from the value parsed, e.g. `["addresses", 0, "zip"]`; `[]` for the value itself. |
| `message` | What is wrong, in words, e.g. `must match format "email"`.                                                         |
| `source`  | Who rejected it: the property name (`email`), or `blueprint`, or the record name.                                  |
| `cause`   | For an issue a property raised, the exception it stands for, built the first time it is read.                      |

`cause` is not among the keys of an issue: `Object.keys`, a spread and `JSON.stringify` leave it out, so an issue sent to a client carries no trace. How validation works is in [Standard Schema](../standard-schema.md).

## Codes

| Code             | When                                                                                      | Example message                                |
| ---------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `required`       | A field that is not optional got `undefined`, or is missing.                              | `is required`                                  |
| `invalid_type`   | Not an object where a blueprint expects one, or not an array where a list expects one.    | `must be an object`, `must be an array`        |
| `invalid_value`  | A property rejected the value: its type, its schema or one of its handlers.               | `must match format "email"`, `must be integer` |
| `undeclared_key` | A key the blueprint does not declare, at any depth. The value is rejected, never trimmed. | `is not declared`                              |
| `too_few_items`  | A list with fewer items than its `minItems`.                                              | `must have at least 1 items`                   |
| `too_many_items` | A list with more items than its `maxItems`.                                               | `must have at most 2 items`                    |
| `not_record`     | A record field got neither an instance of its class nor a valid value of its blueprint.   | `must be an instance of record "Address"`      |

A few cases to know:

- **A property of the wrong type** is `invalid_value`, not `invalid_type`: a property checks the type of the value first, as part of its own validation (`Email.safeParse(1)` gives `must be string`). `invalid_type` is about the shape of a blueprint or a list.
- **A variant** whose key names no variant gives one `invalid_value` issue at the key (`["payment", "kind"]`).
- **A record class whose constructor throws** (a subclass that checks a rule of its own) gives one `invalid_value` issue at `[]`, with the error as its `cause`. See [Standard Schema](../standard-schema.md).
- **JSON checked by a schema** (`jsonOf`, `checkJsonSchema`, `jsonSchemaIssues`) uses the same codes: a missing key is `required`, a key `additionalProperties: false` forbids is `undeclared_key`, a value of the wrong type is `invalid_type` and any other keyword is `invalid_value` ([Properties](../properties.md#json)).

## In practice

```ts
import { blueprintOf, listOf } from "@afora/core";

const Address = blueprintOf((ctx) => ({ street: ctx.text, zip: ctx.string }));
const Signup = blueprintOf((ctx) => ({
	name: ctx.text,
	email: ctx.email,
	addresses: listOf(Address, { minItems: 1 }),
}));

const result = Signup.safeParse({
	email: "jane",
	addresses: [],
	plan: "pro",
});

if (result.issues) {
	for (const { code, path, message } of result.issues) {
		console.log(code, path.join("."), message);
	}
	// undeclared_key  plan       is not declared
	// required        name       is required
	// invalid_value   email      must match format "email"
	// too_few_items   addresses  must have at least 1 items
}
```

Where issues end up:

- **A use case** throws `InvalidUseCaseInput` (or `InvalidUseCaseContext`) with the issues in `details.issues`.
- **An output** (the HTTP providers, the `websocket` sink) answers 400 with a problem+json whose `issues` are these issues, `cause` left out ([Outputs](../outputs.md)).
- **A record built with `new`** throws for the first issue, with every issue in `details.issues`: the exception of the property that raised it (`InvalidPropertyValue`, `PropertyRequired`) passed up to the `Record` layer, `UndeclaredRecordProperty` for a key it does not declare, or `InvalidRecordValue` for any other.

The status each exception gives is in the [exceptions reference](exceptions.md).
