# Access

A use case says who may call it, as data, and every output enforces it before the use case runs. What the OpenAPI document says about an operation is derived from the same declaration, so the two cannot disagree.

```ts
import { Access, blueprintOf, entityOf, useCaseOf } from "@afora/core";

const blueprint = blueprintOf((ctx) => ({ authorId: ctx.id, title: ctx.text }));
class Post extends entityOf(blueprint) {}
const response = blueprintOf(() => ({ post: Post }));

class PublishPost extends useCaseOf({
	name: "PublishPost",
	blueprint,
	response,
	context: blueprintOf((ctx) => ({ userId: ctx.id })),
	access: {
		scopes: ["posts:write"],
		owner: { input: "authorId" },
		context: { userId: "subject" },
	},
}) {
	override async execute() {
		return { post: new Post(this.input) };
	}
}
```

The same declaration, as a decorator of the class:

<!-- docs:code continue -->
```ts
@Access({ scopes: ["posts:write"] })
class PublishPostByDecorator extends useCaseOf({
	name: "PublishPost",
	blueprint,
	response,
}) {
	override async execute() {
		return { post: new Post(this.input) };
	}
}
```

## The declaration

| `access`                      | Who may call                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| not declared                  | Anyone: nothing is checked, as before.                                                            |
| `{ public: true }`            | Anyone, said on purpose: the document marks the operation as public.                              |
| `{}`                          | Any authenticated caller.                                                                         |
| `{ scopes: [...] }`           | A caller that has **all** the scopes.                                                             |
| `{ owner: { input } }`        | A caller whose `subject` equals the input key `input` (a scalar key), as its property handles it. |
| `{ owner: { input, claim } }` | A caller whose claim `claim` equals that input key (a tenant, say).                               |
| `{ context: { key: … } }`     | Any authenticated caller; the context key is filled from it (see below).                          |

The options combine, and all of them must hold. `public: true` takes no other option. A declaration that does not fit the input throws `InvalidUseCaseDeclaration` when the use case is declared, as does a class whose `@Access` says something else than the access it already has. `PublishPost.access` is the frozen declaration, `app.describe().useCases.PublishPost.access` and `afora.json` carry it.

**The caller** is a `Principal`: `{ subject, scopes, claims? }`. The sink that receives a request makes it from the credentials (a bearer token, a cookie) and passes it with the call; see the package of each sink for how it authenticates. A call with no principal is an anonymous one.

**`context`** fills keys of the [context](use-cases.md#context-and-metadata) of the call from the caller: `"subject"`, `"scopes"` or `"claims.<name>"`. The value replaces whatever the request sent for that key, so a use case that reads `this.context.userId` reads who was authenticated, never a header a client chose. A key the context of the operation does not declare throws `InvalidOutputStage` when the output is declared. This is also how the ownership of the [standard use cases](std-use-cases.md) is tied to the caller: their `owner: { context: "userId" }` option compares a field of the stored entity with that context key, inside the use case, with the one read it already makes.

**`owner`** compares a key of the input, before anything is read: it fits operations whose input names the owner (`/users/{id}/orders`). When the owner is a field of a stored entity, use the `owner` option of the standard use cases, or compare in the use case.

The input key is compared after its property handles it, the value the use case acts on: an `Email` trimmed and lowercased, a `Slug` slugified. The subject or claim is compared as it was issued, so it must already be in that form: an authenticator that receives `Ana@Example.com` from its identity provider puts `ana@example.com` in the principal. A value the property rejects is a `Forbidden` with `details.reason: "owner"`, and so is a claim that is not a string, a number or a boolean; a number is compared as text (`42` and the subject `"42"`).

## Enforcement

The check is made once per operation, when the output is declared, and runs inside `invoke` of the [operation](outputs.md), so every sink enforces it: `hono`, `websocket`, `mcpTools` and any sink written later.

| Failure                                | Exception         | Status |
| -------------------------------------- | ----------------- | ------ |
| No caller, or credentials not accepted | `Unauthenticated` | 401    |
| A scope is missing (`details.scopes`)  | `Forbidden`       | 403    |
| The caller is not the owner            | `Forbidden`       | 403    |

Both are exceptions of the `Output` layer, served as `application/problem+json` like any other; `details.reason` of `Forbidden` is `"scope"` or `"owner"`. The check comes before the input is validated, so an anonymous caller learns nothing about the input of a protected operation: only the owner key is parsed, by its own property, once the caller is authenticated and has the scopes.

- **It fails closed.** A sink that passes no principal gets a 401 from every operation with an `access` other than `public`. Adding `access` to a use case served by a sink with no authentication configured closes that operation.
- **A call in process is trusted.** `new UseCase(input).execute()`, `app.run(...)` and `command.run(...)` are your own code and are not checked: the boundary is the output.
- **The `statuses` of an output** can still change the status of either exception, by name.

## In the OpenAPI document

With `security.schemes` in the options of the sink, an operation with an `access` gets its `security` from the declaration: the `default` scheme, else the only scheme, with the declared `scopes`. `{ public: true }` is `security: []` under a `default`. Each such operation documents a `401`, and a `403` when it declares `scopes` or an `owner`. An entry in `security.operations` still documents an operation by hand, but `false` on an operation with an `access` throws `InvalidOutputStage`: the document would call public what the output refuses.

## Changing a password

`update` never takes the `password` of an `authenticatable` entity, nor any sensitive key: a `PATCH /users/{id}` that took it would let any caller who can reach it set another user's password. `changePassword` is the use case for it: it asks for the current password, checks it with `verifyPassword` and throws `UseCaseInvalidCredentials` (401, the error of `login`) when it does not match, then stores the hash of the new one, checked by the password rules (`InvalidUseCaseInput`, a 400).

```ts
import { blueprintOf, commandOf, entityOf, repositoryOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text })),
	{
		change: ["name"],
		plugins: (ctx) => [ctx.authenticatable],
	},
) {}
const Users = repositoryOf({
	entity: User,
	actions: ["findById", "findByEmail", "create", "update"],
});

const self = { key: "id", context: "userId" } as const; // the user is the caller
const Account = commandOf({
	name: "Account",
	useCases: (ctx) => ({
		rename: ctx.update(Users, { owner: self }), // { id, name? }: no password
		changePassword: ctx.changePassword(Users, {
			owner: self,
			access: { context: { userId: "subject" } },
			route: { method: "post", path: "/users/{id}/password" },
		}),
	}),
});
```

`owner: { key: "id", context }` compares the id of the entity with the caller, so a user changes only their own password; the access `context: { userId: "subject" }` fills that context from the token. `change.password` stays on the entity, for a reset flow written by hand (a token sent by email, say).

**Login does not tell which emails exist.** When the email is unknown, `login` still verifies the password given against a hash of a password nobody has, made once by the configured hasher on the first such login (not at import), and answers the same `UseCaseInvalidCredentials`, so the time of the answer is the same for a known and an unknown email. A stored hash the default hasher cannot read gets that answer too, in the same time (see [Runtime](runtime.md#password-hashing)).

## Tokens and sessions

**Experimental.** What follows is imported from `@afora/core/experimental` or marked as such, and may change in any release (see [API tiers](api-tiers.md)). The declaration of access above is stable; how a caller gets and presents a token is what may still move.

afora ships one ready-made way to authenticate: JSON Web Tokens signed with a shared secret (HMAC), on Web Crypto, so the same code runs on Bun, Node and Workers. It is three pieces that share one set of options.

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
import { hono } from "@afora/hono";

class User extends entityOf(
	blueprintOf((ctx) => ({ roles: ctx.list.string })),
	{
		plugins: (ctx) => [ctx.authenticatable],
	},
) {}
const Users = repositoryOf({
	entity: User,
	actions: ["findById", "findByEmail", "create"],
});
class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
const Posts = commandOf({
	name: "Posts",
	useCases: resourceOf(
		repositoryOf({ entity: Post, actions: ["findById", "findPage", "create"] }),
		{ path: "/posts", actions: ["get", "list", "create"] },
	),
});

const token = {
	secret: { env: "JWT_SECRET" }, // at least 32 characters
	issuer: "blog",
	expiresIn: 900, // seconds; the default
	refresh: { expiresIn: 60 * 60 * 24 * 30 },
	scopesFrom: "roles", // a key of the entity that holds its scopes
} as const;

const Auth = commandOf({
	name: "Auth",
	useCases: (ctx) => ({
		register: ctx.register(Users, {
			values: { roles: [] }, // the token is made from roles: never from the input
			route: { method: "post", path: "/users", status: 201 },
		}),
		login: ctx.login(Users, {
			token,
			route: { method: "post", path: "/login" },
		}),
		refresh: ctx.refresh(Users, {
			token,
			route: { method: "post", path: "/refresh" },
		}),
	}),
});

const Api = outputOf({
	name: "Api",
	commands: [Auth, Posts],
	pipe: [
		hono({ auth: { jwt: { secret: { env: "JWT_SECRET" }, issuer: "blog" } } }),
	],
});
```

- **`login` with `token`** answers `{ item, token }`, and `refreshToken` too with `refresh`. The token is signed for the entity: its `id` is the subject, its scopes are `scopes` (a fixed list) plus the list held by the key `scopesFrom`, and `claims: { tenant: "tenantId" }` copies keys of the entity into claims. Each scope is a scope token: not empty, without spaces or control characters, since a token keeps its scopes space separated. A fixed scope that is not one throws `UseCaseUnavailable` when the use case is declared, and `login` gives no token to an entity that holds one (a 500). `claims` cannot name a registered claim (`sub`, `scope`, `iat`, `exp`, `nbf`, `iss`, `aud`, `use`): `UseCaseUnavailable` too.
- **`register` does not take the keys a token is made from.** Whoever calls `register` would otherwise choose their own scopes and claims. So a `register` whose input takes a key that the `token.scopesFrom` or `token.claims` of a `login` or `refresh` of the same entity reads throws `UseCaseUnavailable` at declaration, whichever of them is declared first and in whatever command: set the key with `values` (or leave an optional one out with `omit`), and change it with a use case that only an administrator can call.
- **`refresh`** takes `{ refreshToken }` and answers a new `{ token, refreshToken }`, if the entity still exists. A refresh token is signed for that use only: it is not accepted as an access token, nor the other way round.
- **A refresh token belongs to its entity.** It is signed for the refresh of the entity that issued it (its `use` names the entity, `refresh:<Entity>`), so the `refresh` of another entity refuses it as it refuses any invalid token (`Unauthenticated`, 401), even when the two share the secret and an id. An access token names its entity by id only (the subject): where several authenticatable entities share a secret, scopes and owner checks read that id alone, so give such entities ids that cannot be the same (the default `Id`, a UUID v7) or tell them apart by their scopes.
- **`auth.jwt`** in the options of a sink that serves HTTP is the authenticator: it reads `Authorization: Bearer <token>` (another header with `header`), verifies it and gives the `Principal` that the [access](#the-declaration) of each use case is checked against. The OpenAPI document gets the matching security scheme. An `authenticator` given in the hooks of the sink replaces it.
- **The secret is named, never written.** These options are described by `describe()` and stored in `afora.json`, so `secret` is `{ env: "NAME" }` there; the variable is read when the first token is signed or verified, and a missing or short one throws `InvalidJwtOptions`.

A token is refused, with a 401, when it is malformed (a signature not in the one encoding `sign` gives included), signed with another secret or algorithm (the algorithm is the one of the options, never the one the token names), expired, or of another issuer, audience or use.

**Sessions in cookies.** The route of a use case can send keys of its response as cookies, with [`setCookie`](use-cases.md#routes), and read input keys from cookies, with `cookie`. So a browser session is the same three use cases with other routes:

<!-- docs:code continue -->
```ts
const sid = { name: "sid" }; // HttpOnly; Secure; SameSite=Lax; Path=/
const rid = { name: "rid", path: "/refresh", maxAge: 60 * 60 * 24 * 30 };

const Session = commandOf({
	name: "Session",
	useCases: (ctx) => ({
		login: ctx.login(Users, {
			token,
			route: {
				method: "post",
				path: "/login",
				setCookie: { token: sid, refreshToken: rid },
			},
		}),
		refresh: ctx.refresh(Users, {
			token,
			route: {
				method: "post",
				path: "/refresh",
				cookie: { refreshToken: "rid" },
				setCookie: { token: sid, refreshToken: rid },
			},
		}),
		logout: ctx.logout(Users, {
			route: {
				method: "post",
				path: "/logout",
				setCookie: { token: sid, refreshToken: rid },
			},
		}),
	}),
});

// and the sink reads the token from the cookie:
hono({
	auth: {
		jwt: { secret: { env: "JWT_SECRET" }, issuer: "blog", cookie: "sid" },
	},
});
```

The tokens then never reach the body, and `logout`, which answers empty tokens, removes both cookies.

A browser sends the cookie with every request to the API, a form posted from another page included (with `SameSite=Lax`, the default, only from a page of the same site). The routes read a body only as JSON (see [Serving HTTP](outputs.md)): a form's `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data` body is a 415, and a page of another origin can send `application/json` only after a CORS preflight that the server allows. A request with no body and no `content-type` is still read as `{}`, so an operation whose input is all optional (`logout`, `refresh`) can be called that way: keep `SameSite` at `Lax` or `Strict`, and check the `Origin` of such requests in a middleware where the cookie is `SameSite=None` or other sites share the domain.

**What it does not do.** Tokens are not stored, so there is no revocation: a token already issued is valid until it expires, and `logout` only removes cookies. Keep `expiresIn` short and let `refresh` renew it; a deleted entity cannot refresh. For revocation, rotation with reuse detection, asymmetric keys or an identity provider, write the `authenticator` hook and your own use cases; the declaration of access does not change.

**By hand.** `jwtOf(options)` is the same signer on its own: `sign({ subject, scopes?, claims? }, { expiresIn?, use? })`, `verify(token, { use? })` and `authenticator({ header?, cookie? })`. Here the secret may be the text itself. `sign` rejects with `InvalidJwtOptions` a scope that is not a scope token, and leaves out of the token a claim with a registered name: those are the token's own.

```ts
import { jwtOf } from "@afora/core/experimental";
import { hono } from "@afora/hono";

declare const user: { id: string }; // the signed-in entity

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET is not set");

const jwt = jwtOf({ secret, issuer: "blog" });
const token = await jwt.sign({ subject: user.id, scopes: ["posts:write"] });
hono({}, { authenticator: jwt.authenticator() });
```
