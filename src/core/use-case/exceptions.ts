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
