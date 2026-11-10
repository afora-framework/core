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

| Option                                           | Of                                             | Does                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                           | all                                            | the `useCaseName`; by default the verb and the entity name, as `CreatePost`, `ListPost`, `RegisterUser`                                                                                     |
| `description`, `tags`, `deprecated`              | all                                            | the metadata of the use case                                                                                                                                                                |
| `errors: { notFound, conflict, invalid, owner }` | all                                            | exception classes thrown in place of `UseCaseEntityNotFound` (404), `UseCaseEntityConflict` (409, `register`), `UseCaseInvalidCredentials` (401, `login`); `owner` is `notFound` by default |
| `as`                                             | all but `list`                                 | the response key that holds the entity, typed: `{ as: "post" }` gives `{ post }`                                                                                                            |
| `owner: { key?, context }`                       | all but `restore`, `register`, `login`         | the caller owns the entity, see below                                                                                                                                                       |
| `omit: [...]`                                    | `create`, `register`                           | optional keys the input does not take                                                                                                                                                       |
| `values: { ... }`                                | `create`, `register`                           | values the entity is built with, in place of taking them from the input                                                                                                                     |
| `set: { ... }`                                   | `publish`, `unpublish`, `archive`, `unarchive` | change keys set before the entity is stored, e.g. `{ status: "published" }`                                                                                                                 |
| `orderBy: [{ key, direction? }]`                 | `list`                                         | the order of the page; newest first (`createdAt` descending) by default                                                                                                                     |

Options are JSON and exception classes, so each use case can be written in `afora.json` too.

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

## In an application

A command registers the standard use cases it holds, under their names, so they are not listed in `useCases` (see [Applications](applications.md)); their repositories, the repositories of the entities they load and the errors given in options are checked like the dependencies and errors of any use case. Two use cases with the same name, e.g. `ctx.list(Posts)` and `ctx.list(Posts, { owner })`, conflict until one is given a `name`. `describe()` gives each `generic: { name, version, repository, options }`.

## Limits

- No pluralization: `ctx.list(Posts)` is `ListPost`; name it (`{ name: "ListPosts" }`).
- `list` has no filters besides `owner`, and pages by `offset`.
- A key that holds an entity that may be absent, or a list of entities, is not taken by an input.
- One behavior per property class: the input of a `Password` is always a plain password.
