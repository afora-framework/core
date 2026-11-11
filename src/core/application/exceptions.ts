import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `applicationOf` got a declaration that is not of the kind its collection holds. */
export const InvalidApplicationDeclaration = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "InvalidApplicationDeclaration",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** One object is registered under two names in the same collections. */
export const DuplicateApplicationDeclaration = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "DuplicateApplicationDeclaration",
	message: ({
		first,
		second,
	}: {
		readonly first: string;
		readonly second: string;
	}) => `The same object is registered as ${first} and as ${second}.`,
});

/**
 * Extended applications disagree: one name holds different objects, or one
 * object has different names. `details` names both origins.
 */
export const ApplicationConflict = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "ApplicationConflict",
	message: ({
		reason,
	}: {
		readonly reason: string;
		/** The applications that registered the two declarations. */
		readonly origins: readonly [string, string];
		readonly declarations: readonly [string, string];
	}) => reason,
});

/** A record or entity held by a declaration of the application is not registered in it. */
export const UnregisteredApplicationReference = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "UnregisteredApplicationReference",
	message: ({
		holder,
		reference,
	}: {
		readonly holder: string;
		readonly reference: string;
	}) =>
		`${holder} holds ${reference}, which is not registered in the application.`,
});

/** The entity, relations or environments of a repository are not registered in the application. */
export const UnregisteredRepositoryDependency = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "UnregisteredRepositoryDependency",
	message: ({
		repository,
		dependency,
	}: {
		readonly repository: string;
		readonly dependency: string;
	}) =>
		`Repository ${repository} depends on ${dependency}, which is not registered in the application.`,
});

/** A dependency of a use case of the application (a use case, repository or environment) is not registered in it. */
export const UnregisteredUseCaseDependency = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "UnregisteredUseCaseDependency",
	message: ({
		useCase,
		dependency,
	}: {
		readonly useCase: string;
		readonly dependency: string;
	}) =>
		`Use case ${useCase} depends on ${dependency}, which is not registered in the application.`,
});

/**
 * The application provider is made by `providerFrom` and the application has
 * not been started: `await app.start()` creates it.
 */
export const ApplicationNotStarted = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "ApplicationNotStarted",
	message: ({
		application,
	}: {
		/** The application, or none when `useApplication()` found none started. */
		readonly application?: string;
	}) =>
		application === undefined
			? "No application is started: call await app.start() first."
			: `The application "${application}" is not started: call await app.start() first.`,
});

/**
 * A repository read or wrote through a provider of `providersOf` made by
 * `providerFrom` outside an application: an application that registers the
 * storage makes it on start, and its bound repositories use it.
 */
export const ProviderNotBound = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "ProviderNotBound",
	message: ({
		provider,
	}: {
		/** The key of the provider in its storage. */
		readonly provider: string;
	}) =>
		`The provider "${provider}" is made by an application: register its storage in applicationOf({ providers }) and call the repository through the application.`,
});

/**
 * `app.start()` was called while another application is the started one of
 * the process; `start({ replace: true })` stops it and takes its place.
 */
export const ApplicationAlreadyStarted = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "ApplicationAlreadyStarted",
	message: ({
		current,
		attempted,
	}: {
		readonly current: string;
		readonly attempted: string;
	}) =>
		`The application "${current}" is already started, so "${attempted}" cannot be: stop it, or call start({ replace: true }).`,
});

/**
 * `app.start({ lock })` found that the code cannot run over the stores the
 * lock describes: an entity of the lock that no entity is named or lists in
 * `previousNames` (renamed without it, its rows would no longer be read), or
 * an entity whose `schemaVersion` is lower than the lock's.
 * `details.problems` lists each.
 */
export const SchemaLockMismatch = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "SchemaLockMismatch",
	message: ({ problems }: { readonly problems: readonly string[] }) =>
		`The application does not match its schema lock: ${problems.join(" ")}`,
});

/**
 * `app.migrate` got invalid options, or names an entity without a
 * repository; `source` is the application name.
 */
export const InvalidSchemaMigration = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "InvalidSchemaMigration",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/**
 * `app.start()` found environments whose variables are missing or rejected;
 * `details.environments` gives the keys of each, by name.
 */
export const InvalidApplicationEnvironment = exceptionOf({
	layer: ExceptionLayers.Environment,
	name: "InvalidApplicationEnvironment",
	message: ({
		environments,
	}: {
		readonly environments: Readonly<Record<string, readonly string[]>>;
	}) =>
		`Invalid environment variables: ${Object.entries(environments)
			.map(([name, keys]) => `${name} (${keys.join(", ")})`)
			.join("; ")}.`,
});
