# Exceptions

Every error the library raises is an `Exception` that knows its `layer` (`ExceptionLayers`: `Schema`, `Property`, `Blueprint`, `Record`, `Entity`, `UseCase`, `Repository`, `Environment`, `Event`, `Command`, `Output`), its `name` and its `source` (who raised it). Passing it up keeps the whole `trace`:

```ts
import {
	ExceptionLayers,
	exceptionOf,
	guard,
	InvalidPropertyValue,
} from "@afora/core";

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
		return pass(); // or send it up, with this layer added to the trace
	},
);

// or wrap it in an exception of your own
throw new UserNotCreated({ source: "CreateUser", cause: exception });
```

`exception.trace` lists each step from the origin, `exception.origin` is the first one raised, and `toJSON()`/`toString()` print all of it.
