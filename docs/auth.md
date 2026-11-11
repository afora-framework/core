# Access

A use case says who may call it, as data, and every output enforces it before the use case runs. What the OpenAPI document says about an operation is derived from the same declaration, so the two cannot disagree.

```ts
import { Access, blueprintOf, useCaseOf } from "@afora/core";

class PublishPost extends useCaseOf({
	name: "PublishPost",
	blueprint: blueprintOf((ctx) => ({ authorId: ctx.id, title: ctx.text })),
	response: blueprintOf(() => ({ post: Post })),
	context: blueprintOf((ctx) => ({ userId: ctx.id })),
	access: {
		scopes: ["posts:write"],
		owner: { input: "authorId" },
		context: { userId: "subject" },
	},
}) {
	// ...
}

// The same declaration, as a decorator of the class:
@Access({ scopes: ["posts:write"] })
class PublishPost extends useCaseOf({
	name: "PublishPost",
	blueprint,
	response,
}) {
	// ...
}
```

## The declaration

| `access`                      | Who may call                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| not declared                  | Anyone: nothing is checked, as before.                                   |
| `{ public: true }`            | Anyone, said on purpose: the document marks the operation as public.     |
| `{}`                          | Any authenticated caller.                                                |
| `{ scopes: [...] }`           | A caller that has **all** the scopes.                                    |
| `{ owner: { input } }`        | A caller whose `subject` equals the input key `input` (a scalar key).    |
| `{ owner: { input, claim } }` | A caller whose claim `claim` equals that input key (a tenant, say).      |
| `{ context: { key: … } }`     | Any authenticated caller; the context key is filled from it (see below). |

The options combine, and all of them must hold. `public: true` takes no other option. A declaration that does not fit the input throws `InvalidUseCaseDeclaration` when the use case is declared, as does a class with both the setting and `@Access`. `PublishPost.access` is the frozen declaration, `app.describe().useCases.PublishPost.access` and `afora.json` carry it.

**The caller** is a `Principal`: `{ subject, scopes, claims? }`. The sink that receives a request makes it from the credentials (a bearer token, a cookie) and passes it with the call; see the package of each sink for how it authenticates. A call with no principal is an anonymous one.

**`context`** fills keys of the [context](use-cases.md#context-and-metadata) of the call from the caller: `"subject"`, `"scopes"` or `"claims.<name>"`. The value replaces whatever the request sent for that key, so a use case that reads `this.context.userId` reads who was authenticated, never a header a client chose. A key the context of the operation does not declare throws `InvalidOutputStage` when the output is declared. This is also how the ownership of the [standard use cases](std-use-cases.md) is tied to the caller: their `owner: { context: "userId" }` option compares a field of the stored entity with that context key, inside the use case, with the one read it already makes.

**`owner`** compares a key of the input, before anything is read: it fits operations whose input names the owner (`/users/{id}/orders`). When the owner is a field of a stored entity, use the `owner` option of the standard use cases, or compare in the use case.

## Enforcement

The check is made once per operation, when the output is declared, and runs inside `invoke` of the [operation](outputs.md), so every sink enforces it: `hono`, `websocket`, `mcpTools` and any sink written later.

| Failure                                | Exception         | Status |
| -------------------------------------- | ----------------- | ------ |
| No caller, or credentials not accepted | `Unauthenticated` | 401    |
| A scope is missing (`details.scopes`)  | `Forbidden`       | 403    |
| The caller is not the owner            | `Forbidden`       | 403    |

Both are exceptions of the `Output` layer, served as `application/problem+json` like any other; `details.reason` of `Forbidden` is `"scope"` or `"owner"`. The check comes before the input is validated, so an anonymous caller learns nothing about the input of a protected operation.

- **It fails closed.** A sink that passes no principal gets a 401 from every operation with an `access` other than `public`. Adding `access` to a use case served by a sink with no authentication configured closes that operation.
- **A call in process is trusted.** `new UseCase(input).execute()`, `app.run(...)` and `command.run(...)` are your own code and are not checked: the boundary is the output.
- **The `statuses` of an output** can still change the status of either exception, by name.

## In the OpenAPI document

With `security.schemes` in the options of the sink, an operation with an `access` gets its `security` from the declaration: the `default` scheme, else the only scheme, with the declared `scopes`. `{ public: true }` is `security: []` under a `default`. Each such operation documents a `401`, and a `403` when it declares `scopes` or an `owner`. An entry in `security.operations` still documents an operation by hand, but `false` on an operation with an `access` throws `InvalidOutputStage`: the document would call public what the output refuses.
