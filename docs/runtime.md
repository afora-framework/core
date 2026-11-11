# Runtime

afora runs on Bun (1.4.4 or later) and Node.js (22 or later), and loads in browsers and in Workers. The code you write is the same everywhere: what changes from one runtime to another is two services, password hashing and id generation, which `configure` replaces, and the server that feeds requests to an output.

## What runs where

| Feature                                    | Bun            | Node 24.7+           | Node 22 to 24.6         | Browsers, Workers       |
| ------------------------------------------ | -------------- | -------------------- | ----------------------- | ----------------------- |
| Properties, blueprints, records, entities  | yes            | yes                  | yes                     | yes                     |
| Repositories, use cases, commands, outputs | yes            | yes                  | yes                     | yes                     |
| `Id.generate()` (UUID v7)                  | yes            | yes                  | yes                     | yes                     |
| `Password.hash` and `verify` (argon2id)    | `Bun.password` | native `node:crypto` | `configure({ hasher })` | `configure({ hasher })` |
| `password.verifySync`                      | yes            | yes                  | with a hasher that can  | with a hasher that can  |

afora imports no `node:crypto`, no `Buffer` and no Bun API when it loads, so importing it never fails on a runtime that lacks them. What a runtime may lack is looked up on first use: the native argon2 of Node through `process.getBuiltinModule` (Node 22.3 and later), `Bun.password` on Bun. Ids use only `crypto.getRandomValues`, which every runtime has.

Validation is TypeBox: it compiles a validator with `new Function` where the runtime allows it, and checks by walking the schema where it does not (Workers, a page with a strict Content Security Policy), so the same code runs, more slowly there. `checkJsonSchema` and `jsonSchemaIssues` always walk the schema, since their schemas are known only at runtime ([Properties](properties.md#json)).

The companion packages say where they run in their READMEs: [`@afora/hono`](../packages/hono/README.md) and [`@afora/ws`](../packages/ws/README.md) use only web APIs (Bun, Node, Workers); [`@afora/fastify`](../packages/fastify/README.md) and [`@afora/express`](../packages/express/README.md) run where their server does (Node and Bun); [`@afora/elysia`](../packages/elysia/README.md) on Bun, and on Node 22.18 and later through Elysia's adapter; the CLIs of [`@afora/codegen`](../packages/codegen/README.md) and [`@afora/mcp`](../packages/mcp/README.md) on Node or Bun, with Bun (or Node 22.18 and later, where type stripping is on by default) to import TypeScript files.

## Password hashing

`Password` stores an argon2id hash (see [Standard properties](std-properties.md#passwords)). The hasher is chosen the first time one is needed, not at import:

1. On Bun, `Bun.password`, with argon2id.
2. On a Node that has native argon2 (24.7 and later), `node:crypto`, with the same settings as Bun's default (64 MiB of memory, 2 passes, parallelism 1), so a hash made on one verifies on the other.
3. Anywhere else, a hasher that throws `PasswordHasherRequired` on use, until you configure one.

The native Node hasher derives argon2 version 19 only (the version Bun and most libraries write). A hash of another version throws `UnsupportedPasswordHash`: verify it with `Bun.password`, or configure a hasher that reads it.

A hasher is an object with `hash(plain)` and `verify(plain, hash)`, both asynchronous, and optionally `verifySync(plain, hash)`. Without `verifySync`, `password.verifySync` throws `SyncVerifyUnsupported`; `password.verify` always works. On a browser, a Worker or an older Node, give afora any argon2 library that runs there, once, before the first password is hashed:

```ts
import { configure, type PasswordHasher } from "@afora/core";

// Any argon2id library that runs on the target, e.g. one built to WebAssembly.
declare const argon2: {
	hash(plain: string): Promise<string>;
	verify(plain: string, hash: string): Promise<boolean>;
};

const hasher: PasswordHasher = {
	hash: (plain) => argon2.hash(plain),
	verify: (plain, hash) => argon2.verify(plain, hash),
};

configure({ hasher });
```

The hash it gives must be a PHC string of argon2 (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`), since that is what `Password` accepts.

## Ids

`Id.generate()`, and every entity that gets an `id`, use a UUID v7 (RFC 9562): 48 bits of Unix milliseconds, then a counter for ids made in the same millisecond, then random bits. Ids sort in creation order, within one process too, which keeps database indexes compact and makes `findCursor` over `id` follow creation.

Replace the generator with `configure({ idGenerator })`. Its ids must still be UUID v7, since `Id` accepts nothing else; an id made by a generator you configured is validated as any value would be. In tests, a generator that counts makes ids you can predict:

```ts
import { configure, Id, resetRuntime } from "@afora/core";

let next = 0;
configure({
	idGenerator: () =>
		`01890000-0000-7000-8000-${String(++next).padStart(12, "0")}`,
});

Id.generate().value; // "01890000-0000-7000-8000-000000000001"

resetRuntime(); // the default hasher and generator again, and the id clock restarted
```

## `configure` and `resetRuntime`

`configure({ hasher, idGenerator })` replaces either service, or both; a service it is not given stays as it is. The services are global to the process (or the isolate), so call `configure` once, at start, before the first password or id is made, and not per request.

`resetRuntime()` puts both back to their defaults, chooses the hasher again on its next use, and restarts the clock of the id generator. It is for tests: call it after each test that configures something, so one test's hasher does not leak into the next.

## Deploying

An output built with an HTTP provider is a server object of that framework: a Hono app, a Fastify instance, an Express app or an Elysia app. Deploying it is deploying that framework's app. With [`@afora/hono`](../packages/hono/README.md), the one that runs everywhere, and `api` the built output of `./api.ts` (as in the [docs index](README.md)):

**Bun.**

<!-- docs:code skip: imports the application of the page, `./api`, which is not a file here -->
```ts
import { api } from "./api";

Bun.serve({ fetch: api.fetch, port: 3000 });
```

**Node.** With `@hono/node-server`, and `tsx` (or a build step) to run TypeScript:

<!-- docs:code skip: @hono/node-server is not installed in this repository -->
```ts
import { serve } from "@hono/node-server";
import { api } from "./api";

serve({ fetch: api.fetch, port: 3000 });
```

**Workers.** The app is the default export; configure a hasher if the API hashes passwords, and read variables from the bindings:

<!-- docs:code skip: imports the application of the page, `./api`, which is not a file here -->
```ts
import { configure } from "@afora/core";
import { api } from "./api";
import { hasher } from "./hasher";

configure({ hasher });

export default api;
```

**Browsers.** Records, blueprints and `safeParse` work in the browser as they do on the server, so a form can validate with the same blueprint as the API ([Standard Schema](standard-schema.md)). Import only what the page needs: hashing belongs on the server.

A few things to check for every target:

- **Names in a bundle.** A bundler that minifies renames classes, and a repository keys its storage by the entity's name. Declare it: `entityOf(blueprint, { name: "User" })` (see [Records](records.md)). Code generated by `@afora/codegen` already does.
- **Environment.** `environmentOf` reads `process.env` by default; on Workers, pass the bindings with `source`, and let `await app.start()` validate every environment before the first request ([Environments](environments.md), [Applications](applications.md)).
- **One application per process.** `app.start()` makes the started application of the process (or isolate); a second one throws `ApplicationAlreadyStarted` unless it replaces the first.
- **Node smoke test.** This repository runs the built package on plain Node with `bun run smoke`; do the same with your own build if you deploy on Node but develop on Bun.
