# Applications

`applicationOf` gathers the declarations of an app in one named, immutable manifest, so everything runs in one context and can be inspected:

```ts
const Blog = applicationOf({
	name: "blog",
	properties: { Age, Status },
	blueprints: { Address },
	entities: { User, Post },
	environments: { Database },
	repositories: { Users, Posts },
	provider: inMemoryProvider(), // the default of the repositories that declared none
});

Blog.entities.User; // the declarations, by name
Blog.repositories.Users; // typed; bound to Blog's provider
Blog.repository(Users); // the same, from the original
```

It checks the set as a whole when declared: one object under two names (`DuplicateApplicationDeclaration`), an entity or record held at any depth (fields, lists, optionals, nested blueprints) that is not registered (`UnregisteredApplicationReference`), and a repository whose entity, `relations` or `environmentDependencies` are not (`UnregisteredRepositoryDependency`). A declaration of the wrong kind throws `InvalidApplicationDeclaration`.

`extends: [Auth]`, or `Blog.extend(Billing)`, which returns a new application, inherits declarations; the extended ones stay usable alone and are never changed. The same object under the same name is registered once; one name for different objects, or one object under two names, throws `ApplicationConflict` naming both origins. References may cross applications (a `Post` of `Blog` holding the `User` of `Auth`), and validation runs on the resolved set.

Use cases are registered by name too: `useCases: { Register, CreateUser }` (concrete classes, keyed by their `useCaseName`) and `exceptions: { UserAlreadyExists }` (made by `exceptionOf`, keyed by their `name`); another key throws `InvalidApplicationDeclaration`. The resolved set (extended applications included) is checked: every dependency of a use case must be registered, a use case, repository or environment (`UnregisteredUseCaseDependency`, with `details.useCase` and `details.dependency`); records and entities held by its `blueprint`, `response` or `context` must be registered (`UnregisteredApplicationReference`); and each class in `errors` must be in `exceptions`, unless it is an exception exported by `@afora/core` such as `RepositoryUniqueViolation` (`UnregisteredApplicationReference` otherwise).

With a `provider`, `app.useCases.Register` is a subclass of `Register` whose `dependencies` swap each repository for the application's bound one, through child use cases too; it is the same subclass every time, and `Register` itself is never changed. Without a provider, `app.useCases.Register === Register`. `app.useCase(Register)` gives the same class from the original, as `app.repository(Users)` does.

Commands are registered the same way (`commands: { Users }`, keyed by `commandName`); with a provider `app.commands.Users` runs over the bound use cases (see [Commands](commands.md)).

Outputs are registered with `outputs: { Api }`, keyed by `outputName` (`InvalidApplicationDeclaration`, which also rejects unnamed outputs made by `.pipe`); every command of an output must be registered in `commands` (`UnregisteredApplicationReference`, `details: { output, command }`). With a `provider`, `app.outputs.Api` (or `app.output(Api)`) is the output rebuilt over the application-bound commands, with the same name, statuses and stages, memoized, so `invoke` on its operations writes through the application provider. `app.describe().outputs` gives, for each output, `from`, `name`, `commands` (names), `statuses` and `pipe`: each stage as `{ kind: "transform" | "sink", name, options }`, or `{ kind: "opaque" }` for a hand-written stage.

Repositories are module-level and may be shared, so an application does not change them: `app.repositories.Users` shares the declaration of `Users` but reads and writes through the `provider` of the application (or of the last application it extends that has one), unless `Users` declared its own. Two applications with different providers do not share data. Without a `provider`, `app.repositories.Users` is `Users` itself, and records, entities and repositories work the same outside any application.

`app.describe()` gives a JSON-serializable graph, with the `from` of each declaration (the application that registered it): properties (name, flags, JSON Schema and `lineage`), blueprints, records and entities (fields, `options`, plugin descriptors), environments, repositories (entity, actions, `relations` and `environments` by name), use cases (`name`, `description`, `tags`, `deprecated`, `input`, `response`, optional `context`, `errors` as `{ kind: "exception", ref }` or `{ kind: "core", name }`, `dependencies` as `{ kind, ref }`, and `implementation`: `{ kind: "steps", steps }` or `{ kind: "opaque" }`) and exceptions (`layer` and, when declared as a string, `message`). A field is a reference by name (`{ kind: "entity", ref: "User" }`) when it holds a registered declaration. A property's `lineage` comes from `propertyLineageOf(Property)`: `Integer.with({ min: 0 })` is `{ kind: "refined", base, options }`, `optionalOf` is `{ kind: "optional", base }` and `enumOf` is `{ kind: "factory", factory: "enumOf", args: { values } }`. A root property (declared with `propertyOf`) has no lineage and is identified by its `name`; one with custom handlers is described with what is known (name and schema), never an error.
