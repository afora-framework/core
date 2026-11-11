# Coming from Hono + Zod

If you write APIs with Hono and Zod, you already work the way afora asks: describe the data, validate at the edge, keep handlers small. This page shows one endpoint written both ways, what moves where, and what you can keep.

## The same endpoint

Registering a user: a unique email, a hashed password that must never be in a response.

**Hono + Zod**

<!-- docs:code skip: the Hono + Zod side of the comparison; zod and db belong to the reader, not to this repo -->
```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const RegisterInput = z.object({
	name: z.string().min(1),
	email: z.string().email().trim().toLowerCase(),
	password: z.string().min(8),
});

const app = new Hono();

app.post("/users", zValidator("json", RegisterInput), async (c) => {
	const input = c.req.valid("json");
	if (await db.users.findByEmail(input.email)) {
		return c.json({ error: "A user with this email already exists." }, 409);
	}
	const user = await db.users.create({
		...input,
		password: await Bun.password.hash(input.password),
	});
	const { password, ...safe } = user; // remember this in every handler that returns a user
	return c.json({ user: safe }, 201);
});
```

**afora**

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
} from "@afora/core";
import { hono } from "@afora/hono";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text })),
	{ plugins: (ctx) => [ctx.authenticatable] }, // a unique email, a hashed and masked password
) {}

const Users = repositoryOf({
	entity: User,
	actions: ["findByEmail", "create"],
});

const Accounts = commandOf({
	name: "Accounts",
	useCases: (ctx) => ({
		register: ctx.register(Users, {
			route: { method: "post", path: "/users", status: 201 },
		}),
	}),
});

const app = outputOf({
	name: "Api",
	commands: [Accounts],
	pipe: [hono()],
}).build(); // a Hono app
```

Both answer `POST /users` with a 201 and refuse a second user with the same email with a 409. The differences are in what you no longer write, and in what can no longer be forgotten.

## What moves where

| With Hono + Zod                                          | With afora                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A Zod schema per request body                            | A **blueprint**: `blueprintOf((ctx) => ({ email: ctx.email }))`. Each field is a property that validates and normalizes. |
| `z.infer<typeof Schema>`                                 | Inferred from the blueprint: `this.input`, the entity class, the response.                                               |
| An object from the database                              | An **entity**: a class whose values were validated when it was built and change only through `change.<key>`.             |
| The handler body                                         | A **use case**: `execute` with typed input, context and dependencies, runnable with no server.                           |
| `app.post("/users", ...)`                                | The `route` of the use case (or `@Route`), served by an output. The path is declared once and documented from it.        |
| `zValidator("json", Schema)`                             | Nothing: the input is validated by the blueprint of the use case, on every transport.                                    |
| `const { password, ...safe } = user` in each handler     | Nothing: a sensitive property is masked by `toJSON()`, at any depth, whoever serializes.                                 |
| `if (exists) return c.json({...}, 409)`                  | `unique: ["email"]`: the repository enforces it and the output answers 409.                                              |
| `return c.json({ error }, 4xx)`                          | `throw new MyError(...)`, an exception with a layer; the output maps it to a status as `application/problem+json`.       |
| An auth middleware that reads the token and checks roles | `access: { scopes: [...] }` on the use case, enforced before it runs; the middleware only says who the caller is.        |
| `@hono/zod-openapi`, kept in step by hand                | The `docs` option: the document is built from the same declarations as the routes.                                       |
| `app.use(cors())`, a rate limiter                        | The same middlewares, given to the sink: `hono(options, { middlewares: [cors()] })`.                                     |

## What changes in how you think

- **The handler is not where the rules are.** In Hono the route is the unit and the handler holds everything. In afora the unit is the use case, and the route is one of the things it declares. The same use case is an HTTP endpoint, an MCP tool and a WebSocket operation, and a plain class in a test.
- **Guarantees are properties of the declarations.** Masking, unique keys, undeclared keys and error statuses are not conventions each handler follows: they hold for every use case, including the one written at 2 a.m., or by an agent.
- **There are more declarations.** An entity, a repository, a command and an output is more than one file with a route. Each has a reason (rules, storage, the boundary of a call, the way out), and for the common case one line covers the middle: [`resourceOf(Posts, { path: "/posts" })`](tutorial.md#2-a-crud-api-on-one-screen) is a whole CRUD.
- **A record is not a plain object.** `{ ...user }` is empty and `user.email = "x"` does nothing: read with `user.email`, change with `user.change.email("x")`, and call `user.toJSON()` for the plain object. See [the tutorial](tutorial.md#a-record-is-not-a-plain-object).

## What you can keep

- **Hono.** The output builds a Hono app: mount it (`main.route("/", api)`), add routes beside it, give it your middlewares, deploy it where you deploy Hono. `hono(options, { app })` adds the routes to an app you already have.
- **Your routes, for now.** Every afora field is a [Standard Schema](standard-schema.md), so a blueprint works in a route you write by hand with `@hono/standard-validator`, as a Zod schema does. You can move one endpoint at a time:

<!-- docs:code skip: types of @hono/standard-validator and hono resolve to two installed copies of hono in the checker; the same code is type-checked by examples/interop (interop.test.ts) -->
```ts
import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

const legacy = new Hono(); // the Hono app you already have

legacy.post("/legacy/users", sValidator("json", User.blueprint), (c) => {
	const input = c.req.valid("json"); // validated and normalized by the blueprint
	return c.json({ name: input.name }, 201);
});
```

- **Zod, where it is.** Nothing stops a Zod schema from validating a part of your application afora does not model.
- **Bun or Node.** The library runs on Bun and on Node 22 or later. The examples use Bun because it runs TypeScript directly; on Node, run them with `npx tsx file.ts`, and serve Hono with `@hono/node-server`, or use [`@afora/fastify`](../packages/fastify/README.md) or [`@afora/express`](../packages/express/README.md), which listen on Node as they are.

## Step by step

The [tutorial](tutorial.md) builds an API from an empty file: a CRUD, a rule of your own, sign in and access, and the document.
