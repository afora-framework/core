# Standard use cases

`commandOf` gives the `useCases` of a command a context of ready-made use cases, each made for a repository. What a use case takes, returns and does follows the repository and its entity: the actions it declares, how it deletes, the record plugins of the entity and the properties of its keys.

```ts
import { blueprintOf, commandOf, entityOf, repositoryOf } from "@afora/core";

class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string, status: ctx.string })),
	{ change: ["title", "status"], plugins: (ctx) => [ctx.publishable] },
) {}
const Posts = repositoryOf({
	entity: Post,
	deletion: "soft",
	actions: ["findById", "findPage", "create", "update", "delete", "restore"],
});

const Blog = commandOf({
	name: "Blog",
	transaction: true,
	useCases: (ctx) => ({
		create: ctx.create(Posts, {
			as: "post",
			omit: ["publishedAt"],
			values: { status: "draft" },
		}),
		list: ctx.list(Posts),
		update: ctx.update(Posts),
		publish: ctx.publish(Posts, { set: { status: "published" } }), // a type error if Post is not publishable
		remove: ctx.delete(Posts),
		restore: ctx.restore(Posts),
		custom: MyUseCase, // classes written by hand go beside them
	}),
});

const { post } = await Blog.run("create", { title: "Hello" });
const { items, total } = await Blog.run("list", { limit: 10 });
await Blog.run("update", { id: post.id, title: "Hello again" }); // status is left as it is
```

Each `ctx.<name>(repository, options?)` gives a use case class, the same as `useCaseOf({ steps })` would: its input and response are typed and validated, `describe()` reports its steps, scope, events, transactions and overrides work as for any use case, and an output exposes it like any other operation. They are [use case plugins](use-cases.md#plugins) in the catalog `StdUseCases`; `StdUseCases.context` is the same `ctx` outside a command, e.g. to depend on one from a use case written by hand (`dependencies: { register: StdUseCases.context.register(Users) }`). The same repository and equal options give the same class, wherever the call is written.

## A resource in one line

`resourceOf(repository, { path })` gives the `useCases` of a command the standard `create`, `get`, `list`, `update` and `delete`, each with the [route](use-cases.md#routes) of a REST resource:

```ts
import { commandOf, resourceOf } from "@afora/core";

const Blog = commandOf({
	name: "Blog",
	useCases: resourceOf(Posts, { path: "/posts" }),
});
// create: POST /posts (201)        list:   GET /posts
// get:    GET /posts/{id}          update: PATCH /posts/{id}        delete: DELETE /posts/{id}
```

It is only a shortcut for `(ctx) => ({ create: ctx.create(Posts, { route: { method: "post", path: "/posts", status: 201 } }), ... })`. The command is an ordinary one: its operations are typed by the repository, `describe()` shows the same standard use cases with their routes, and `afora.json` round-trips them.

| Option    | Does                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | the path of the collection; one entity is at `{path}/{id}`                                                                                                                       |
| `actions` | the operations to give, all five by default: `actions: ["get", "list"]` gives a read-only resource, and the type of the command has only those                                   |
| `access`  | who may call them, see [Access](auth.md): one declaration for every operation, or one per operation (`{ create: { scopes: ["posts:write"] } }`; one left out declares no access) |

Each operation needs its repository actions (`create`; `findById` for `get`; `findPage` for `list`; `findById` and `update`; `findById` and `delete`), and a repository that lacks one throws `UseCaseUnavailable` when the command is declared. For anything more an operation needs (`omit`, `owner`, hooks, another name), write that one with `ctx` and spread the rest, since the result is a function of `ctx`:

```ts
useCases: (ctx) => ({
	...resourceOf(Posts, { path: "/posts", actions: ["get", "list", "delete"] })(ctx),
	create: ctx.create(Posts, {
		values: { status: "draft" },
		route: { method: "post", path: "/posts", status: 201 },
	}),
	publish: PublishPost, // a use case written by hand
}),
```

## The use cases

`id` is the `id` field of the entity, and `<as>` the response key (`item` by default).

| Use case               | The repository needs              | The entity needs  | Input                                  | Response                          |
| ---------------------- | --------------------------------- | ----------------- | -------------------------------------- | --------------------------------- |
| `create`               | `create`                          |                   | the keys of the entity, see below      | `{ <as>: entity }`                |
| `get`                  | `findById`                        |                   | `{ id }`                               | `{ <as>: entity }`                |
| `list`                 | `findPage`                        |                   | `{ limit?, offset? }`                  | `{ items, total, limit, offset }` |
| `update`               | `findById`, `update`              |                   | `{ id }` and each change key, optional | `{ <as>: entity }`                |
| `delete`               | `findById`, `delete`              |                   | `{ id }`                               | `{ <as>: entity }`, deleted       |
| `restore`              | `restore` (so `deletion: "soft"`) |                   | `{ id }`                               | `{ <as>: entity }`, alive         |
| `publish`, `unpublish` | `findById`, `update`              | `publishable`     | `{ id }`                               | `{ <as>: entity }`                |
| `archive`, `unarchive` | `findById`, `update`              | `archivable`      | `{ id }`                               | `{ <as>: entity }`                |
| `tag`, `untag`         | `findById`, `update`              | `taggable`        | `{ id, tags }`, at least one tag       | `{ <as>: entity }`                |
| `register`             | `findByEmail`, `create`           | `authenticatable` | as `create`                            | `{ <as>: entity }`                |
| `login`                | `findByEmail`                     | `authenticatable` | `{ email, password }`                  | `{ <as>: entity }`                |
| `refresh`              | `findById`                        |                   | `{ refreshToken }`                     | `{ token, refreshToken }`         |
| `logout`               |                                   |                   | `{}`                                   | `{ token, refreshToken }`, empty  |

A use case whose repository lacks an action, or whose entity lacks a record plugin, is a type error at the call (`MissingRepositoryAction<"update">`, `MissingRecordPlugin<"publishable">`) and throws `UseCaseUnavailable` when the command is declared, with `details.missing`. So does an option the entity cannot satisfy: an unknown key or option, a required key in `omit`, a `set` on a key that is not a change key.

**What follows the repository.** Only the use cases its actions allow exist. `delete` deletes as the repository does: with `deletion: "soft"` the response carries `deletedAt` and `get` and `list` stop seeing the entity; `restore` exists only for a repository that lists the `restore` action, which needs soft deletion (see [Repositories](repositories.md)), and `restore` of an unknown id throws `RepositoryEntityNotFound`.

**What follows the record plugins.** `publish` and `unpublish` call the methods of `publishable`, `archive` and `unarchive` those of `archivable` (`unarchive` calls its `restore`; the use case named `restore` is the one of soft deletion), `tag` and `untag` those of `taggable` with the tags of the input, and each stores the entity. `register` and `login` are for `authenticatable`: `register` is `create` after checking that the email is free, and `login` gives the entity when `verifyPassword` accepts the password. `login` issues no token: sessions belong to the application.

**What follows the properties**, in the input of `create`, `register` and `update`:

- The identity keys (`id`, `createdAt`, `updatedAt`, `deletedAt`) are never taken.
- A key that holds an entity is taken as `<key>Id`, with the `id` field of that entity: the use case loads it through the repository of the `relations` of the target, which must have `findById`, and throws `notFound` when there is none. A key that holds an entity that may be absent, or a list of entities, is left out of the input (give it in `values`, or change it in a use case written by hand); `update` leaves out every key that holds an entity.
- A property that declares a `PropertyInput` takes what it accepts and stores what it converts to: a `Password` key takes a plain password, validated by the password rules at the input (`InvalidUseCaseInput` with issues, a 400), and stores its hash (see [Properties](properties.md)).
- Every other key takes its own field. `update` takes the keys of `options.change`, each optional, and changes only those the input gives.
- Sensitive keys are masked in the response by `toJSON`, as in any record: a response never shows a password hash.

## Options

| Option                                                          | Of                                                        | Does                                                                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                          | all                                                       | the `useCaseName`; by default the verb and the entity name, as `CreatePost`, `ListPost`, `RegisterUser`                                                                                     |
| `route`, `access`                                               | all                                                       | the [route](use-cases.md#routes) and the [access](auth.md) of the use case, as in `useCaseOf`, checked against the input and the response it ends up with                                   |
| `token: { secret: { env }, ... }`                               | `login`, `refresh`                                        | experimental: the response gains a `token` (and a `refreshToken`, with `refresh`); see [Tokens and sessions](auth.md#tokens-and-sessions)                                                   |
| `description`, `tags`, `deprecated`                             | all                                                       | the metadata of the use case                                                                                                                                                                |
| `errors: { notFound, conflict, invalid, owner }`                | all                                                       | exception classes thrown in place of `UseCaseEntityNotFound` (404), `UseCaseEntityConflict` (409, `register`), `UseCaseInvalidCredentials` (401, `login`); `owner` is `notFound` by default |
| `as`                                                            | all but `list`                                            | the response key that holds the entity, typed: `{ as: "post" }` gives `{ post }`                                                                                                            |
| `owner: { key?, context }`                                      | all but `restore`, `register`, `login`                    | the caller owns the entity, see below                                                                                                                                                       |
| `omit: [...]`                                                   | `create`, `register`                                      | optional keys the input does not take                                                                                                                                                       |
| `values: { ... }`                                               | `create`, `register`                                      | values the entity is built with, in place of taking them from the input                                                                                                                     |
| `set: { ... }`                                                  | `publish`, `unpublish`, `archive`, `unarchive`            | change keys set before the entity is stored, e.g. `{ status: "published" }`                                                                                                                 |
| `orderBy: [{ key, direction? }]`                                | `list`                                                    | the order of the page; newest first (`createdAt` descending) by default                                                                                                                     |
| `before: ({ input, entity?, dependencies, context }) => input?` | the use cases that write (all but `get`, `list`, `login`) | runs before the write and may give back the input to go on with, see [Before and after](#before-and-after)                                                                                  |
| `after: ({ entity, input, dependencies, context }) => void`     | the use cases that write                                  | runs after the write, within the transaction of the command                                                                                                                                 |
| `dependencies: { ... }`                                         | the use cases that write                                  | repositories, use cases, environments or `Logger` by name, joined to those the use case makes, for `before` and `after`                                                                     |
| `throws: [...]`                                                 | the use cases that write                                  | exception classes `before` and `after` throw: added to the errors of the use case                                                                                                           |

Options are JSON, exception classes and, for the hooks, functions and dependencies, so each use case can be written in `afora.json` too (`before` and `after` as imports).

**`owner`** says that `key` holds who owns the entity, as an id (`ownerId` by default, the key of the `ownable` plugin) or as an entity, and that the key `context` of the context holds the id of the caller. The use case then declares that context (`{ userId: id }`), and:

- `create` does not take the key from the input: it stores the id of the caller, or loads the caller by id for a key that holds an entity (`errors.owner` when there is none);
- `get`, `update`, `delete` and the plugin use cases throw `notFound` for an entity of another owner, as if it did not exist;
- `list` gives only the entities of the caller.

```ts
const owner = { key: "author", context: "userId" } as const;
const Blog = commandOf({
	name: "Blog",
	useCases: (ctx) => ({
		create: ctx.create(Posts, { owner }),
		remove: ctx.delete(Posts, { owner, errors: { notFound: PostNotFound } }),
	}),
});
await Blog.run("create", { title: "Mine" }, { context: { userId } });
```

`restore` takes no `owner`: a deleted entity cannot be read to check who owns it before it is back.

## Before and after

A write often needs a check the entity cannot make alone: a lookup in another repository, data checked against a schema loaded at runtime, a key renamed before it is stored. `before` and `after` put it around the write of a standard use case, without writing the use case by hand:

- `before({ input, entity?, dependencies, context })` runs before the write: first thing in `create`, `register` and `restore`; after the entity is loaded and its owner checked in `update`, `delete` and the plugin use cases, which give it as `entity`. What it gives back, if anything, is the input the use case goes on with (the keys it builds, changes or looks up, `register`'s email check included); `undefined` keeps the input given. The entity still validates what it is built or changed with.
- `after({ entity, input, dependencies, context })` runs after the write, with the entity written and the input `before` gave, before the response is given. In a command with `transaction: true` it runs inside the transaction, so what it throws rolls the write back.
- `dependencies` are repositories, use cases, environments or `Logger`, by name, joined to those the use case makes (`repository`, and `<key>Repository` for each key that holds an entity; a name taken by both is `UseCaseUnavailable`). Both hooks get all of them as the call resolved them, overrides of `execute` included.
- `throws` lists the exceptions the hooks throw: they go to `static errors`, so `describe()` reports them and an output gives them 422 (or what its `statuses` say). An exception with `details.issues`, such as `InvalidJsonData`, is a 400 anyway.

The types follow the repository and the options: `input` is the parsed input of the use case (`omit`, `values` and `owner` taken into account), `entity` an instance of the entity, `dependencies` typed by name and `context` the context `owner` declares (`undefined` without one). `get`, `list` and `login` do not write, so they take no hooks: a type error, and `UseCaseUnavailable` at declaration.

A CMS whose entries hold `data` checked against the JSON Schema of their content type, stored in another repository:

```ts
import {
	blueprintOf,
	checkJsonSchema,
	commandOf,
	entityOf,
	ExceptionLayers,
	exceptionOf,
	InvalidJsonData,
	repositoryOf,
} from "@afora/core";

const ContentTypeNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ContentTypeNotFound",
	message: "No such content type.",
});

class ContentType extends entityOf(
	blueprintOf((ctx) => ({ slug: ctx.slug, schema: ctx.json })),
	{ unique: ["slug"] },
) {}
class Entry extends entityOf(
	blueprintOf((ctx) => ({ type: ctx.slug, data: ctx.json })),
	{ change: ["data"] },
) {}
const ContentTypes = repositoryOf({
	entity: ContentType,
	actions: ["findBySlug"],
});
const Entries = repositoryOf({
	entity: Entry,
	actions: ["findById", "create", "update"],
});

const Cms = commandOf({
	name: "Cms",
	transaction: true,
	useCases: (ctx) => ({
		create: ctx.create(Entries, {
			dependencies: { contentTypes: ContentTypes },
			throws: [ContentTypeNotFound, InvalidJsonData],
			before: async ({ input, dependencies }) => {
				const type = await dependencies.contentTypes.findBySlug(input.type);
				if (!type) throw new ContentTypeNotFound({ source: input.type });
				checkJsonSchema(type.schema, input.data, { source: input.type }); // InvalidJsonData, a 400 with its issues
				return { ...input, data: renamed(type, input.data) }; // what is stored (renamed: the app's own)
			},
			after: async ({ entity, dependencies }) => {
				/* history, notifications: within the transaction */
			},
		}),
		update: ctx.update(Entries, {
			dependencies: { contentTypes: ContentTypes },
			throws: [ContentTypeNotFound, InvalidJsonData],
			before: async ({ input, entity, dependencies }) => {
				if (input.data === undefined) return; // nothing to check
				const type = await dependencies.contentTypes.findBySlug(entity.type);
				if (!type) throw new ContentTypeNotFound({ source: entity.type });
				checkJsonSchema(type.schema, input.data, { source: entity.type });
			},
		}),
	}),
});
```

The hooks are `run` steps of the use case (see [Steps](use-cases.md#steps)): `describe()` gives them as `{ run: "before", fn: { kind: "opaque" }, as: "prepared" }` and `{ run: "after" }`, with the steps after `before` reading `$prepared` in place of `$input`, and the options as `before: { kind: "opaque" }`, the dependencies by registered name and `throws` by exception name.

## In an application

A command registers the standard use cases it holds, under their names, so they are not listed in `useCases` (see [Applications](applications.md)); their repositories, the repositories of the entities they load and the errors given in options are checked like the dependencies and errors of any use case. Two use cases with the same name, e.g. `ctx.list(Posts)` and `ctx.list(Posts, { owner })`, conflict until one is given a `name`. `describe()` gives each `generic: { name, version, repository, options }`.

## Limits

- No pluralization: `ctx.list(Posts)` is `ListPost`; name it (`{ name: "ListPosts" }`).
- `list` has no filters besides `owner`, and pages by `offset`.
- A key that holds an entity that may be absent, or a list of entities, is not taken by an input.
- One behavior per property class: the input of a `Password` is always a plain password.
