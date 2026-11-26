import type { IdValue } from "../entity/types/id.interface";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";

/** A query contains unsupported keys, ordering or pagination. */
export const InvalidRepositoryQuery = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryQuery",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/**
 * `findCursor` got an `after` that is not a cursor it gave, or one made for
 * another `orderBy`; `source` is the repository name. Its `issues` name the
 * `after` of the query, so an output answers it as invalid input.
 */
export const InvalidRepositoryCursor = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryCursor",
	message: ({
		reason,
	}: {
		readonly reason: string;
		readonly issues: readonly Issue[];
	}) => reason,
});

/** `repositoryOf` got something other than an entity, actions and a provider. */
export const InvalidRepositoryDeclaration = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryDeclaration",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** A method of a repository was assigned or redefined, as `spyOn` does. */
export const RepositoryIsFrozen = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryIsFrozen",
	message: ({
		repository,
		member,
	}: {
		readonly repository: string;
		readonly member: string;
	}) =>
		`The repository ${repository} is frozen: "${member}" cannot be replaced. It is shared by every use case and application that names it. To observe it, wrap the provider with spyProvider from @afora/core/testing; to replace it for one call, override it in execute (execute({ ${repository}: { ${member}: ... } })). See docs/testing.md#spying-on-the-database.`,
});

/** A method of a repository got a value that is not an entity of it. */
export const InvalidRepositoryEntity = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryEntity",
	message: (_details: undefined, source) =>
		`"${source}" expected an entity of its own class.`,
});

/**
 * A stored row holds a schema version (`SCHEMA_VERSION_KEY`) that is not a
 * positive integer, or that is above the `schemaVersion` of its entity (it
 * was written by newer code), or an `upgrade` step did not give an object.
 * `source` is the repository name; reads throw it as the cause of
 * `InvalidRepositoryData`.
 */
export const InvalidStoredSchemaVersion = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidStoredSchemaVersion",
	message: (
		{
			id,
			stored,
			current,
			reason,
		}: {
			readonly id: IdValue;
			readonly stored: unknown;
			readonly current: number;
			readonly reason?: string;
		},
		source,
	) =>
		reason ??
		`"${source}" read the row "${id}" stored at schema version ${JSON.stringify(stored)}, and its entity is at version ${current}.`,
});

/** A provider gave a value its entity rejects; `source` is the repository name. */
export const InvalidRepositoryData = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryData",
	message: (_details: undefined, source) =>
		`"${source}" read a value that its entity rejects.`,
});

/** Another entity holds the value of a unique key; `source` is the repository name. */
export const RepositoryUniqueViolation = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryUniqueViolation",
	message: ({ key }: { readonly key: string }, source) =>
		`"${source}" already holds an entity with this "${key}".`,
});

/**
 * A repository declared at module level was called after an application
 * bound it to its provider: the calls of the application go through
 * `app.repositories.<key>`, its use cases (`app.run`, `app.useCase`) or a
 * repository given to `execute`; `source` is the repository name.
 */
export const RepositoryUsedOutsideApplication = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryUsedOutsideApplication",
	message: (
		{
			application,
			repository,
		}: { readonly application: string; readonly repository: string },
		source,
	) =>
		`"${source}" is bound to the application "${application}", and its declaration no longer reads or writes: use app.repositories.${repository}, run its use cases with app.run, or give the repository of the application to execute.`,
});

/**
 * A repository no application bound was written to while an application of
 * `testApplicationOf(app, { strict: true })` ran: its rows would outlive
 * the test. `source` is the repository name.
 */
export const RepositoryWrittenOutsideApplication = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryWrittenOutsideApplication",
	message: ({ application }: { readonly application: string }, source) =>
		`"${source}" is not bound to an application, and the test application "${application}" runs in strict mode: register it in the application and call it through app.repositories, the use cases of the application, or a repository given to execute.`,
});

/** No entity of the id was found; `source` is the repository name. */
export const RepositoryEntityNotFound = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryEntityNotFound",
	message: ({ id }: { readonly id: IdValue }, source) =>
		`"${source}" holds no entity of id "${id}".`,
});

/**
 * `update` of a versioned entity found another version stored than the one
 * it read: someone else wrote it in between (optimistic concurrency).
 * `actual` is the stored version, when the provider knows it; `source` is the
 * repository name. An output answers it with 409.
 */
export const RepositoryConcurrencyConflict = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryConcurrencyConflict",
	message: (
		{
			id,
			expected,
		}: {
			readonly id: IdValue;
			readonly expected: number;
			readonly actual?: number;
		},
		source,
	) =>
		`"${source}" holds another version of "${id}" than ${expected}: it changed since it was read.`,
});

/**
 * `delete` found entities of a repository that declares the deleted entity
 * its parent with `onDelete: "restrict"` (directly, or under a parent it
 * cascades to), so it deleted nothing. `id` is the parent they hold,
 * `child` the repository holding them and `key` the key holding its id;
 * `source` is the repository whose `delete` was called. An output answers
 * it with 409.
 */
export const RepositoryDeleteRestricted = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryDeleteRestricted",
	message: (
		{
			id,
			child,
			key,
		}: {
			readonly id: IdValue;
			readonly child: string;
			readonly key: string;
		},
		source,
	) =>
		`"${source}" deleted nothing: "${child}" holds entities whose "${key}" is "${id}", and it restricts the delete of their parent.`,
});

/**
 * `increment` got deltas it cannot apply: a key that is not a number in the
 * `change` list of the entity, or a value that is not a finite number. Its
 * `issues` name each, so an output answers it as invalid input.
 */
export const InvalidRepositoryIncrement = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryIncrement",
	message: ({
		reason,
	}: {
		readonly reason: string;
		readonly issues: readonly Issue[];
	}) => reason,
});

/**
 * The entity has ids the database assigns (`Serial`) and the provider does
 * not assign them (no `capabilities.generatedIds`), or gave no valid id for
 * an entity it inserted; `source` is the repository name, or the
 * application whose provider is made on start.
 */
export const UnsupportedIdentity = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "UnsupportedIdentity",
	message: ({ reason }: { readonly entity: string; readonly reason: string }) =>
		reason,
});

/**
 * An entity whose id the database assigns (`Serial`) was given to a
 * repository before `create` stored it, so it has no id yet: to `update`,
 * `delete`, `restore` or `increment`, or held by another entity (stored by
 * its id). `source` is the repository name, or the name of the entity held.
 */
export const UnstoredEntity = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "UnstoredEntity",
	message: ({ reason }: { readonly entity: string; readonly reason: string }) =>
		reason,
});
