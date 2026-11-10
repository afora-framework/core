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

/** A method of a repository got a value that is not an entity of it. */
export const InvalidRepositoryEntity = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "InvalidRepositoryEntity",
	message: (_details: undefined, source) =>
		`"${source}" expected an entity of its own class.`,
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

/** No entity of the id was found; `source` is the repository name. */
export const RepositoryEntityNotFound = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "RepositoryEntityNotFound",
	message: ({ id }: { readonly id: string }, source) =>
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
			readonly id: string;
			readonly expected: number;
			readonly actual?: number;
		},
		source,
	) =>
		`"${source}" holds another version of "${id}" than ${expected}: it changed since it was read.`,
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
