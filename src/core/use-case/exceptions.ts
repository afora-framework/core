import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";

/**
 * A step of a use case is invalid: at declaration (`useCaseOf({ steps })`),
 * or while the steps run (a `change` or `invoke` on something that is not a
 * record or has no such member, or `args` that a `run`'s `params` reject).
 * `details.index` is the position of the step.
 */
export const InvalidUseCaseStep = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidUseCaseStep",
	message: ({
		index,
		reason,
	}: {
		readonly index: number;
		readonly reason: string;
		readonly code?: string;
		/** The issues of the `args` a `run` gave its `params` (`code: "invalid_args"`). */
		readonly issues?: readonly Issue[];
	}) => `Invalid step ${index}: ${reason}`,
});

/**
 * `useCasePluginOf` or `useCaseCatalogOf` was given what cannot be a plugin
 * or a catalog: an invalid name or version, no `compile`, two plugins with
 * one name; or a plugin was called with something that is not a repository
 * or with options that are not a plain object. `source` is the plugin name.
 */
export const InvalidUseCasePlugin = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidUseCasePlugin",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid use case plugin "${source}": ${reason}.`,
});

/** A catalog has no use case plugin of that name; `source` is `catalog`. */
export const UnknownUseCasePlugin = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UnknownUseCasePlugin",
	message: ({ name }: { readonly name: string }) =>
		`No use case plugin "${name}" in the catalog.`,
});

/** The use case plugin of a catalog does not satisfy the version asked for; `source` is the plugin name. */
export const IncompatibleUseCasePlugin = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "IncompatibleUseCasePlugin",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Incompatible use case plugin "${source}": ${reason}.`,
});

/**
 * A use case plugin cannot make its use case for a repository: the
 * repository lacks an action, the entity lacks a record plugin, or an option
 * names what the entity does not have. `source` is the plugin name.
 */
export const UseCaseUnavailable = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UseCaseUnavailable",
	message: (
		{
			repository,
			reason,
		}: {
			readonly repository: string;
			readonly reason: string;
			readonly missing?: {
				readonly actions: readonly string[];
				readonly plugins: readonly string[];
			};
		},
		source,
	) =>
		`The use case "${source}" is not available for "${repository}": ${reason}.`,
});

/** What a use case made by a plugin throws for an entity it did not find, unless given another error. */
export const UseCaseEntityNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UseCaseEntityNotFound",
	message: "The entity was not found.",
});

/** What a use case made by a plugin throws for an entity that already exists, unless given another error. */
export const UseCaseEntityConflict = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UseCaseEntityConflict",
	message: "The entity already exists.",
});

/** What a use case made by a plugin throws for credentials that do not match, unless given another error. */
export const UseCaseInvalidCredentials = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UseCaseInvalidCredentials",
	message: "Invalid credentials.",
});

/**
 * The `replace` of a call (`UseCase.run`, `app.run`, `command.run` or
 * `command.execute`) names declarations that no use case it runs declares,
 * past those it replaces: a renamed or removed dependency is not silently
 * left unreplaced. `details.replacements` names each one; `source` is the
 * use case called.
 */
export const UnusedUseCaseReplacement = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UnusedUseCaseReplacement",
	message: ({ replacements }: { readonly replacements: readonly string[] }) =>
		`No use case of the call declares ${replacements.join(", ")}: replace only what one of them declares.`,
});

/**
 * A use case read a service (see `serviceOf`) that nothing gives it: no
 * application binds the name in its `services`, and `execute` was not given a
 * value for it. `details.service` is the name of the service.
 */
export const ServiceNotBound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ServiceNotBound",
	message: ({ service }: { readonly service: string }) =>
		`The service "${service}" is not bound: give it in the services of an application, or as an override of execute.`,
});

/**
 * A use case read a service (see `serviceOf`) before its `execute` started or
 * after it ended: a service is made when `execute` starts, so it is read
 * inside `execute`. `details.service` is the name of the service.
 */
export const ServiceOutsideExecution = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ServiceOutsideExecution",
	message: ({ service }: { readonly service: string }) =>
		`The service "${service}" is available only while execute runs: read it inside execute.`,
});
