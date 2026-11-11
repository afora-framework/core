# UseCases

`useCaseOf` declares an abstract operation with input and response blueprints and a collection of concrete UseCase classes as dependencies. This combines the **Command** pattern (an instance holds the operation's arguments) with **method injection** (dependency functions are supplied to `execute`).

```ts
import { blueprintOf, entityOf, useCaseOf } from "@afora/core";

const UserInput = blueprintOf((ctx) => ({ name: ctx.string }));
class User extends entityOf(UserInput) {}
const UserResponse = blueprintOf(() => ({ user: User }));

class CreateUser extends useCaseOf({
	name: "CreateUser",
	blueprint: UserInput,
	response: UserResponse,
}) {
	override async execute() {
		return { user: new User(this.input) };
	}
}

class RegisterUser extends useCaseOf({
	name: "RegisterUser",
	blueprint: UserInput,
	dependencies: { createUser: CreateUser },
	response: UserResponse,
}) {
	override async execute({ createUser = this.dependencies.createUser } = {}) {
		return await createUser(this.input);
	}
}

const operation = new RegisterUser({ name: "Ana" });
const { user } = await operation.execute();
for (const event of operation.pullEvents()) await event.handle();

// Partial overrides replace direct dependencies; other dependencies resolve normally.
await new RegisterUser({ name: "Ana" }).execute({
	createUser: async (input) => ({ user: new User(input) }),
});
```

The constructor validates its arguments and exposes their parsed values as read-only `this.input`. Implement `execute` as an async prototype method, not an arrow-function field. It must return the value shape of the response blueprint, including record/entity instances for those fields. The framework wraps the method automatically to validate the response and collect events; no `super.execute()` call is needed. Each instance allows one execution attempt, including failures; concurrent or subsequent calls reject with `UseCaseAlreadyExecuted`.

A repository dependency is the repository it was declared with, so `new RegisterUser(input).execute()` on the module-level class reads and writes through that repository's own provider, until an application binds the repository to its provider: from then on it throws `RepositoryUsedOutsideApplication`. Inside an application, run the class the application gives instead: `await app.run(RegisterUser, input)`, or `new app.useCases.RegisterUser(input).execute()` (also `app.useCase(RegisterUser)`, `app.get(RegisterUser)`), which is a subclass whose repositories, and those of its child use cases, are the ones bound to the application's provider. See [Applications](applications.md).

Dependencies default to `{}`. Each dependency function creates a fresh child, resolves its dependencies and returns its validated response. Await all dependency calls before returning. Functions are usable only during execution: one called after `execute` has ended throws `InvalidUseCaseDependencies`, as does an override that names a dependency the use case does not declare or gives the wrong kind of value for one (an environment override its blueprint rejects included). Use the destructured defaults shown above to keep both no-argument calls and partial overrides inferred in TypeScript. `execute(deps = this.dependencies)` also supports no-argument calls, but its inferred override type requires the complete dependency map. During execution, `this.dependencies` exposes the resolved functions, including overrides. Overrides apply only to direct dependencies, and their inputs and responses are validated against the declared child. There is no global container.

Events from managed children move to the parent when each child finishes, including on failure and when the parent's response omits the child result. Then the validated parent response is traversed through declared records, entities, nested blueprints and lists. Repeated object references are visited once; separately emitted duplicate events are preserved. Child events follow completion order, followed by remaining response events. No handlers run automatically. `pullEvents()` immediately drains the queue, which remains available after failure. Invalid responses are not drained. Overrides contribute events from their returned entities; hidden operations inside an override must expose their events separately.

In an application with a `log`, each execution, each repository call made through it and a failure, once, are logged. A use case that logs itself declares `Logger` as a dependency (`dependencies: { logger: Logger }`) and gets an `ILogger`, which `execute` can replace like any dependency; see [Logging](logging.md).

## Context and metadata

A use case can declare a `context`, a blueprint for what the caller supplies with each call (the signed-in user, a request id), and metadata that tools can read:

<!-- docs:code continue -->
```ts
import {
	exceptionOf,
	ExceptionLayers,
	RepositoryUniqueViolation,
} from "@afora/core";

const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: "A user with this email exists.",
});

const RegisterBase = useCaseOf({
	name: "Register",
	blueprint: UserInput,
	response: UserResponse,
	context: blueprintOf((ctx) => ({ userId: ctx.id, requestId: ctx.string })),
	description: "Signs a user up.", // optional
	tags: ["users"], // optional, default []
	deprecated: false, // optional, default false
	errors: [UserAlreadyExists, RepositoryUniqueViolation], // exceptionOf classes a caller should expect
});

class Register extends RegisterBase {
	override async execute() {
		return { user: new User(this.input) };
	}
}

const registration = new Register(
	{ name: "Ana" },
	{ context: { userId: user.id, requestId: "req-1" } },
);
registration.context; // Readonly<{ userId: string; requestId: string }>, parsed and frozen
```

With a declared `context`, the second constructor argument is required by type and validated by its blueprint; a missing or invalid one throws `InvalidUseCaseContext` (`UseCase` layer, `details.issues`). Without one, `options.context` is not accepted and `this.context` is `undefined`. `UseCaseContext<typeof Register>` extracts the type, and `UseCaseOptions` is the type of the second argument.

A child called through a dependency function receives its parent's context narrowed to the keys of its own `context` blueprint and validated by it. A child with no context gets none; a child that declares one under a parent without context fails with `InvalidUseCaseContext`. Overrides passed to `execute` keep the signature `(input) => response`.

The class gets the frozen statics `context`, `description`, `tags`, `deprecated`, `errors`, `route` (see [Routes](#routes)) and `access` (see [Access](auth.md)), beside `useCaseName`, `blueprint`, `response` and `dependencies`. `context` is a non-optional blueprint, `tags` are distinct non-empty strings, and `errors` are distinct classes made by `exceptionOf`; anything else throws `InvalidUseCaseDeclaration`. `errors` documents what to expect and changes nothing at runtime: an exception that is not listed still propagates.

## Routes

A use case can say where it is served over HTTP, next to its input, instead of in the options of a sink:

```ts
import { blueprintOf, Route, useCaseOf } from "@afora/core";

const PostList = blueprintOf((ctx) => ({ titles: ctx.list.text }));
const ListPostsInput = blueprintOf((ctx) => ({
	slug: ctx.slug,
	page: ctx.integer,
	locale: ctx.optional.text,
	session: ctx.text,
}));

class ListPosts extends useCaseOf({
	name: "ListPosts",
	blueprint: ListPostsInput,
	response: PostList,
	route: {
		method: "get",
		path: "/posts/{slug}",
		headers: { locale: "accept-language" },
		cookie: { session: "sid" },
	},
}) {
	override async execute() {
		// this.input: { slug, page, locale?, session }
		return { titles: [] };
	}
}
```

The same declaration, as a decorator of the class:

<!-- docs:code continue -->
```ts
@Route("GET", "/posts/{slug}", {
	headers: { locale: "accept-language" },
	cookie: { session: "sid" },
})
class ListPostsByDecorator extends useCaseOf({
	name: "ListPosts",
	blueprint: ListPostsInput,
	response: PostList,
}) {
	override async execute() {
		return { titles: [] };
	}
}
```

The blueprint stays the only description of the input: a route adds no schema, it says where each key is read from.

- **`method`** is `get`, `post`, `put`, `patch` or `delete`, in either case; it is stored in lower case.
- **`path`** starts with `/`, and a `{name}` segment fills the input key `name`. Without a path, the sink uses its default (`/{command}/{operation}`).
- **`status`** is the status of a success: `200` (the default), `201`, `202` or `204`.
- **`query`** lists input keys read from the query string. A `get` or `delete` route already reads from the query every key that has no other place, so `query` is for routes with a body.
- **`headers`** and **`cookie`** map input keys to the header or the cookie each is read from: `{ locale: "accept-language" }`.
- **What is left** is the JSON body of a `post`, `put` or `patch`, and the query of a `get` or `delete`.
- **`setCookie`** maps keys of the _response_ to cookies: `{ token: { name: "sid" } }` sends the `token` of the response as the cookie `sid` and leaves it out of the body. A cookie is `{ name, httpOnly?, secure?, sameSite?, path?, domain?, maxAge? }`, by default `HttpOnly; Secure; SameSite=Lax; Path=/`. An empty text removes the cookie, and an absent value sets none. The key must be a scalar key of the response.

A key read from the path, the query, a header or a cookie arrives as text, so it must be a scalar property of the input (a number or a boolean is converted), and each key has one place. Anything else throws `InvalidUseCaseDeclaration` when the use case is declared, as does a class whose decorator says another route than the one it already has (the same route again is accepted, which is what a class over a base generated from `afora.json` does).

The route is data: `ListPosts.route` is the frozen declaration, `app.describe().useCases.ListPosts.route` and `afora.json` carry it, and a subclass inherits it. It names no server. The use case becomes an operation through a [command](commands.md), and the sink of an [output](outputs.md) (`openapi`, `hono`…) serves or documents it; the `route` option of that sink still overrides the method, path and status per operation id.

`@Route(method, path?, options?)` (or `@Route(method, options)`) is a standard class decorator, with no `experimentalDecorators` and no metadata reflection; it also works as a legacy TypeScript decorator. Bun runs it as written. Node has no decorator syntax yet, so there the code goes through a compiler (`tsc` with a `target` of `ES2022` or lower, `tsx`, esbuild), or uses the `route` setting, which needs nothing.

`UseCaseInput`, `UseCaseResponse` and `UseCaseDependencies` extract a declaration's types. `isUseCase` identifies instances; `isUseCaseClass` identifies concrete declarations with a prototype `execute`. UseCases carry their own kind and cannot be used as fields of ordinary data blueprints. Validation errors carry `details.issues`; errors crossing an execution boundary preserve their cause and gain a `UseCase` trace frame using the declared name.

## Steps

Instead of writing `execute`, a use case can declare `steps`: plain data that the use case interprets. The class is concrete, so it needs no body, and `describe()` reports the steps (a hand-written `execute` is `{ kind: "opaque" }`). Steps are a sequence, with no branching, loops or expressions; a rule that needs them is written in code (see [What steps will never have](#what-steps-will-never-have)).

```ts
import {
	blueprintOf,
	entityOf,
	ExceptionLayers,
	exceptionOf,
	Password,
	PlainPassword,
	repositoryOf,
	useCaseOf,
} from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		password: ctx.password,
	})),
	{ unique: ["email"] },
) {}
const Users = repositoryOf({
	entity: User,
	actions: ["findByEmail", "create"],
});
const RegisterInput = blueprintOf((ctx) => ({
	name: ctx.text,
	email: ctx.email,
	plainPassword: PlainPassword,
}));
const UserResponse = blueprintOf(() => ({ user: User }));
const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: "A user with this email exists.",
});
const hashPassword = async (plain: string) =>
	(await Password.hash(plain)).value as string;

class Register extends useCaseOf({
	name: "Register",
	blueprint: RegisterInput, // { name, email, plainPassword }
	response: UserResponse, // { user: User }
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: UserAlreadyExists },
		{
			run: "hashPassword",
			fn: hashPassword,
			args: ["$input.plainPassword"],
			as: "hash",
		},
		{
			build: User,
			values: { name: "$input.name", email: "$input.email", password: "$hash" },
			as: "user",
		},
		{ create: "users", value: "$user", as: "saved" },
		{ return: { user: "$saved" } },
	],
}) {}
```

The steps are the same objects in TypeScript and in JSON, except for the class of `build`, the exception class of `ensure.error` and the function of `run`, which the descriptor names or marks `opaque`. TypeScript checks the dependency and action names (`"users.findByEmail"` only exists if `Users` has that read action); with [`strictSteps: true`](#strict-steps) it also checks the references and values, which are otherwise checked at declaration and at execution by the blueprints. Steps run in order, each awaited, and every repository and use case call goes through the same dependency functions as a hand-written `execute`: execution scope, events, trace frames, `UseCaseAlreadyExecuted` and `execute({ ...overrides })` behave identically.

A _value_ is a reference, a literal or a mapping:

| Value                             | Meaning                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"$input.email"`                  | the parsed input; a path of identifiers and indices follows the root (`$saved.tags.0`); a missing segment is `undefined` |
| `"$context.userId"`               | the parsed context (only if the use case declares one)                                                                   |
| `"$env.mail.FROM"`                | a variable of an environment dependency                                                                                  |
| `"$name"`                         | the result of an earlier step bound with `as`                                                                            |
| `"text"`, `1`, `true`, `null`     | a JSON literal; write `{ literal: "$5" }` for a string that starts with `$`                                              |
| `{ user: "$saved" }`, `["$a", 2]` | a mapping, resolved recursively                                                                                          |

The `args` of `find`, `invoke` and `run` are a list of values or one reference to a list, which is spread (`args: "$input.tags"` calls `tag(...tags)`); a reference that does not resolve to a list throws `InvalidUseCaseStep` while the steps run.

There are no operators or interpolation: anything computed goes through `run`. The names `input`, `context`, `env` and `literal` are reserved.

**The args of `run` are not checked at run time unless it declares `params`.** `fn` is any function, so without `params` it gets the resolved values as they are, whatever its parameters say (only [`strictSteps`](#strict-steps) checks them, at compile time, and only in TypeScript). `params` is a blueprint whose keys match the `args` by position: the args are parsed before `fn` is called, `fn` gets the values as the keys handled them (an `email` trimmed and lowercased), and a rejected arg throws `InvalidUseCaseStep` with `code: "invalid_args"`, the key in the message and the issues in `details.issues`; `fn` does not run. The number of args must equal the number of keys (checked at declaration for a list, while the steps run for a reference). Declare it whenever `fn` relies on what it gets, and always in an `afora.json` written by an agent:

<!-- docs:code skip: one step of a steps list, not a module -->
```ts
{
	run: "hashPassword",
	fn: hashPassword,
	args: ["$input.plainPassword"],
	params: blueprintOf((ctx) => ({ plain: ctx.string })),
	as: "hash",
}
```

| Step                                                   | Does                                                                                                                                                                               | Result (`as`) |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `{ find: "<repo>.<action>", args?, as? }`              | a read action: `findBy*`, `findManyBy*`, `findMany`, `exists`, `findPage`, `findCursor`, `count` (not `forEachPage`)                                                               | its result    |
| `{ ensure, value, other?, error, details? }`           | `ensure` is `exists`, `absent`, `equals`, `notEquals` (`other` required, structural equality as in queries), `true` or `false`; on failure throws `new error({ source, details })` | none          |
| `{ build: Class, values, as }`                         | `new Class(values)`, a record or entity                                                                                                                                            | the instance  |
| `{ change: "$ref", key, value, ifPresent?, as? }`      | `record.change[key](value)`; `key` must be a change key; with `ifPresent: true` the step is skipped when `value` is `undefined` (a partial update)                                 | the record    |
| `{ invoke: "$ref", method, args?, as? }`               | a public method of a record or entity (`publish`, `verifyPassword`...), awaited                                                                                                    | its result    |
| `{ create \| update \| delete: "<repo>", value, as? }` | the repository action of that name                                                                                                                                                 | its result    |
| `{ restore: "<repo>", value, as? }`                    | the `restore` action of a repository with soft deletion: `value` is the deleted entity or its id                                                                                   | the entity    |
| `{ call: "<useCase>", input, as? }`                    | the use case dependency: validated child, inherited context, events moved up                                                                                                       | its response  |
| `{ run: "<name>", fn, args?, params?, as? }`           | `await fn(...args, { context, dependencies })`, the dependencies as the call resolved them (overrides included); `name` is unique in the use case; see `params` below              | its result    |
| `{ return: value }`                                    | the response, validated by the response blueprint; required, last, once                                                                                                            | none          |

`useCaseOf` validates the steps at declaration and throws `InvalidUseCaseStep` (`UseCase` layer, `details: { index, reason, code }`) for an unknown or malformed step, a bad or repeated `as`, a reference to an unbound name, a `$context` without a declared context, a path of `$input` or `$context` the blueprint lacks at any depth (`$input.address.zipp`, `$input.tags.first`, `$input.name.length` below a string; a list has its indices and its `length`, a number, as in `$input.tags.length`; below a key of a record that its blueprint lacks but its class has, such as a getter, the path is not followed), an unknown repository, action, use case or environment, a `find` of a write action, a `build` that is not a record class, an `ensure.error` missing from `errors`, a `change.key` that is not a change key of the class `build` made, and a missing, repeated or misplaced `return`. A `change` or `invoke` on something that is not a record, or on a member it lacks, throws `InvalidUseCaseStep` with the `index` while the steps run. In an application, the classes of `build` and `ensure.error` must be registered (`UnregisteredApplicationReference`); `describe()` gives `implementation: { kind: "steps", steps }` with them by name (`"User"`, `"UserAlreadyExists"`, or `{ core: "RepositoryUniqueViolation" }` for an exported exception) and `run.fn` as `{ kind: "opaque" }` (its `params` by their fields, as the `input` of a use case). A subclass that overrides `execute` is hand-written, so it is `{ kind: "opaque" }`.

### Strict steps

With `strictSteps: true`, TypeScript checks the steps written inline in `useCaseOf` as it checks a hand-written `execute`. The steps are read in order, each against the values in scope: the input, the context, the environments and the results of the earlier steps, typed (`find` gives what the repository method returns, `build` the instance, `change` the record, `invoke` and `run` what the method or function returns, awaited, `call` the response of the use case). An `ensure: "exists"` on a bound name removes `undefined` from it for the steps after.

<!-- docs:code skip: shows the type error strictSteps reports, so it does not compile on purpose -->
```ts
class Register extends useCaseOf({
	name: "Register",
	blueprint: RegisterInput,
	response: UserResponse,
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	strictSteps: true,
	steps: [
		// Type '"$input.emial"' is not assignable to type '"$input.name" | "$input.email" | "$input.plainPassword"'.
		{ find: "users.findByEmail", args: ["$input.emial"], as: "existing" },
		// ...
	],
}) {}
```

- every reference must name a value in scope, at any depth (`$input.address.zip`, `$existing.email`, `$env.mail.FROM`); a name bound by a later step is an error;
- the `args` of `find`, `invoke` and `run` must fit the parameters of the repository method, the record method and the function (for `run`, without the `{ context, dependencies }` the interpreter adds); the `values` of `build` the input of the record class, keys included (a missing key or one it does not declare is an error); the `value` of `change` the change key, and of `create`, `update`, `delete` and `restore` the repository method; the `input` of `call` the input of the use case;
- `invoke.method` must be a public method of the record, and `change.key` one of its change keys;
- the `return` must fit what the response blueprint takes, keys included (a missing key, a value of another type, or a result that may be `undefined` is an error);
- the values of `ensure` and `details` are checked as references only.

A reference that does not fit is reported with the references that would (`'"$input.emial"' is not assignable to type '"$input.name" | "$input.email" | ...'`), and the editor offers them inside a `"$"` string. When no reference in scope fits, the error names the type that is taken (`Type 'string' is not assignable to type 'number'`); when a reference only fails because it may be `undefined` (the result of a `find` before an `ensure: "exists"`), the references offered include the hint `"$found.email may be undefined: ensure it exists first"`. A path through a value that may be `undefined` (the result of `findByEmail`, an optional key) resolves to a possibly `undefined` value, as `followPath` reads it. A list index is typed as the item. Paths are offered three keys deep below their root.

Checking costs the editor about 11,000 more type instantiations per edit (20%) on a use case of five steps (see `bun run test:type-perf`), which is why it is opt-in. It only applies to steps written inline (a tuple); steps built at run time are checked at declaration only. `strictSteps` has no effect at run time and must be a boolean. The code [codegen](../packages/codegen/README.md) generates from `afora.json` declares it.

### What steps will never have

Steps are for a rule that is a sequence: read, check, build, change, store, call and return, in order. Each step names declared things (a repository action, a record class, an exception, a dependency) and values that are references or literals, so the whole rule is data that a spec, a reviewer or an agent can govern: `useCaseOf` and the `afora.json` validator check every name and path, `describe()` reports the rule, and [`afora.json`](afora-json.md) generates it and extracts it back unchanged.

Steps have no branching (`if`, `switch`), no loops (`forEach`, `while`) and no expressions (operators, interpolation, conditions on values), and will not get them. Each would turn the list into a small programming language inside JSON, with its own scoping, evaluation order and errors, that the validator, the types of [strict steps](#strict-steps) and the round trip would all have to follow. And from 27.0 on the vocabulary is bound by compatibility: a step added once stays in every later version. The vocabulary is the table above.

What does not fit leaves the steps in one of two ways, and neither changes the declaration:

- **A value computed from others** (a hash, a total, a slug): keep the steps and add a `run` step with a function. The function is code; the flow stays data.
- **A rule that branches, loops over a list with effects, or reads better as code**: implement the use case in code. In TypeScript, the class drops `steps` and overrides `execute`. In `afora.json`, `implementation` becomes `{ "import": "../handlers/reserve#Reserve" }`: the generator writes `export abstract class ReserveBase extends useCaseOf({...}) {}` with the same declaration (in `reserve.use-case.ts`), and the hand-written `Reserve` extends it and implements `execute`. The input, response, context, dependencies, errors, route and access stay declared, so the response is still validated, the errors are still listed, and every use case that depends on it stays as it is, a steps use case that `call`s it included. [When steps are not enough](afora-json.md#when-steps-are-not-enough) shows the move, before and after.

Bending a rule into steps with flags and `ensure` tricks to avoid code is not the intent: a use case implemented in code is the supported way out, not a failure of the spec.

## Plugins

A use case plugin is a use case that is made for a repository: its blueprints, dependencies and steps follow the entity, the actions the repository declares and the record plugins of the entity. The [standard ones](std-use-cases.md) (`create`, `list`, `publish`...) are plugins; this is how to write another.

```ts
import {
	type AnyRepository,
	blueprintBuilderOf,
	blueprintOf,
	entityOf,
	type EntityOfRepository,
	type Id,
	repositoryOf,
	type StepsUseCaseConstructor,
	UseCaseEntityNotFound,
	type UseCaseTarget,
	useCaseCatalogOf,
	useCasePluginOf,
} from "@afora/core";

const fields = blueprintBuilderOf();

class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
const Posts = repositoryOf({ entity: Post, actions: ["findById"] });

type GetMaker = <Repository extends AnyRepository>(
	repository: Repository & UseCaseTarget<Repository, "findById">,
	options?: { readonly name?: string },
) => StepsUseCaseConstructor<
	{ readonly id: typeof Id },
	{ readonly item: EntityOfRepository<Repository> },
	{ readonly repository: Repository }
>;

const get = useCasePluginOf<"get", GetMaker>("get", {
	description: "Finds an entity by id.", // optional
	version: "1.0.0", // optional, the default
	requires: { actions: ["findById"] }, // and plugins: ["publishable"]
	compile: (target, options) => ({
		name: (options.name as string | undefined) ?? `Get${target.entityName}`,
		blueprint: fields(() => ({ id: target.field("id").field })),
		response: fields(() => ({ item: target.entity })),
		dependencies: { repository: target.repository },
		errors: [UseCaseEntityNotFound],
		steps: [
			{ find: "repository.findById", args: ["$input.id"], as: "found" },
			{ ensure: "exists", value: "$found", error: UseCaseEntityNotFound },
			{ return: { item: "$found" } },
		],
	}),
});

const GetPost = get.make(Posts); // a class, as useCaseOf({ steps }) gives
const Generics = useCaseCatalogOf(get); // for commandBuilderOf, see Commands
```

`compile` gives the settings of `useCaseOf` with `steps`, so what a plugin makes is an ordinary steps use case: validated at declaration, described by `describe()`, with scope, events and overrides as any other. Its two arguments are the target and the options of the call (a plain object, `{}` when none):

| `target`                                          | Is                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`, `repositoryName`                    | the repository the use case is for, to list in `dependencies`                                                                                                                                   |
| `entity`, `entityName`                            | its entity class and name (the declared `name`, else the name of the class)                                                                                                                     |
| `actions`, `deletion`, `changeKeys`, `uniqueKeys` | what the repository and the entity declare                                                                                                                                                      |
| `fields`, `field(key)`                            | a plan of each key: `field`, `kind` (`property`, `blueprint`, `list`, `record`, `entity`, `entity-list`), `identity`, `plugin`, `sensitive`, `unique`, `optional`, `change`, `related`, `input` |
| `relation(key, actions?)`                         | the repository of the entity a key holds, taken from the `relations` of the target, to load it by id                                                                                            |
| `unavailable(reason)`                             | throws `UseCaseUnavailable` for an option the entity cannot satisfy                                                                                                                             |

The `input` of a plan is what an input blueprint takes for the key: the key and its field, `<key>Id` and the `id` field of the related entity for a key that holds an entity, or the property a `PropertyInput` accepts (see [Properties](properties.md)), whose `convert` the plan then carries. `useCaseTargetOf(repository)`, from `@afora/core/experimental`, gives the same target outside a plugin.

`plugin.make(repository, options)` gives one class per repository and options: the same call anywhere gives the same class (options are compared by value, classes among them by identity), which is what lets a command, an application and a test name the same use case. It throws `UseCaseUnavailable` (`UseCase` layer, `details: { repository, reason, missing }`) when the repository lacks an action of `requires.actions` or the entity a record plugin of `requires.plugins`, `InvalidUseCasePlugin` for what is not a repository or options that are not a plain object, and whatever `useCaseOf` throws for the compiled steps. `useCaseOriginOf(UseCase)` gives `{ plugin, repository, options }` for a class a plugin made (and for a class extending it), `undefined` otherwise.

The second type argument is the call signature of `make`. TypeScript cannot derive it from `compile`, which returns data, so a plugin that wants typed inputs and responses states it; without it any repository is accepted and the class is `AnyUseCaseClass`. `UseCaseTarget<Repository, Actions, Members, Plugin>` is the precondition, written as an intersection with the repository argument: it is nothing when the repository declares every action and its entities have the members of the record plugin, and otherwise a type that names what is missing, so the error reads `MissingRepositoryAction<"update">` or `MissingRecordPlugin<"publishable">`. The plugin check is structural (the entity has the members), so an entity that declares the same members by hand passes the type and fails at declaration.

`useCaseCatalogOf(...plugins)` groups plugins by name (`InvalidUseCasePlugin` for two with one name): `catalog.plugins`, `catalog.list`, `catalog.context` (the `make` of each, by name) and `catalog.resolve("get")` or `("get@1.0.0")`, which throws `UnknownUseCasePlugin` or `IncompatibleUseCasePlugin` (same major version, not older; same minor below 1.0.0). `isUseCasePlugin` and `isUseCaseCatalog` identify them, and `plugin.toJSON()` gives `{ kind: "use-case-plugin", name, version, description?, requires }`.

`UseCaseEntityNotFound`, `UseCaseEntityConflict` and `UseCaseInvalidCredentials` are exceptions for plugins to throw by default; `statusOf` gives them 404, 409 and 401. Being exported by the package, they need no registration in an application.
