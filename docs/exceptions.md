# Exceptions

Every error the library raises is an `Exception` that knows its `layer` (`ExceptionLayers`: `Schema`, `Property`, `Blueprint`, `Record`, `Entity`, `UseCase`, `Repository`, `Environment`, `Event`, `Command`, `Application`, `Output`), its `name` and its `source` (who raised it). Passing it up keeps the whole `trace`:

```ts
import {
	ExceptionLayers,
	exceptionOf,
	guard,
	InvalidPropertyValue,
	PropertyRequired,
	Text,
} from "@afora/core";

const Name = Text;
const input: string | undefined = " Jane ";

const UserNotCreated = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserNotCreated",
	message: "Could not create the user.",
});

guard(
	{ layer: ExceptionLayers.UseCase, source: "CreateUser" },
	() => new Name(input).value,
	(exception, pass) => {
		if (exception.is(InvalidPropertyValue)) return "Jane"; // resolve it here
		if (exception.is(PropertyRequired))
			// or wrap it in an exception of your own
			throw new UserNotCreated({ source: "CreateUser", cause: exception });
		return pass(); // or send it up, with this layer added to the trace
	},
);
```

`exception.trace` lists each step from the origin, `exception.origin` is the first one raised, and `toJSON()`/`toString()` print all of it.

An exception of a declared class keeps its class and its `details` as it goes up, so both checks work on what a repository, a use case or a command rejects with:

```ts
import {
	blueprintOf,
	entityOf,
	RepositoryUniqueViolation,
	repositoryOf,
} from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ email: ctx.email })),
	{
		unique: ["email"],
	},
) {}
const Users = repositoryOf({ entity: User, actions: ["create"] });
await Users.create(new User({ email: "ana@example.com" }));
const duplicate = new User({ email: "ana@example.com" });

try {
	await Users.create(duplicate);
} catch (error) {
	if (error instanceof RepositoryUniqueViolation) error.details.key; // "email"
}
```

`exception.is(Class)` (or `is("Name")`) also looks at the causes, so it is the check to use when the exception may have been wrapped: `propagate` with another `name` or new `details` gives a plain `Exception` with the original as its cause, as a record does for an invalid value (`is(InvalidPropertyValue)` is true, `instanceof` is not), and so does `new UserNotCreated({ cause })`. The constructor of the class does not run again when the exception goes up, and a hand-written `class X extends Exception` is passed up as a plain `Exception`.

[Exceptions reference](reference/exceptions.md) lists every exception afora exports, by layer: what throws it, the status an output answers with, and how to handle it.
