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
