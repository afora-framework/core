/**
 * `@afora/core/adapters`: the plumbing for authors of sinks, providers and
 * code generators (`@afora/hono`, `@afora/drizzle`, `@afora/codegen`...).
 * Part of the compatibility policy in `VERSIONING.md`, like the main entry.
 * Application code needs only `@afora/core`. See `docs/api-tiers.md`.
 */

export {
	diffSchemas,
	schemaLockOf,
	schemaLockProblemsOf,
} from "./core/application/schema";
export type {
	ApplicationDescription,
	CommandDescription,
	ExceptionDescription,
	FieldDescription,
	FieldsDescription,
	LogDescription,
	OutputDescription,
	PropertyDescription,
	PropertyLineageDescription,
	PropertyReference,
	ProviderReference,
	RecordDescription,
	UseCaseDependencyDescription,
	UseCaseDescription,
} from "./core/application/types/application.interface";
export {
	ENTITY_IDENTITY_KEYS,
	RESERVED_ENTITY_KEYS,
} from "./core/entity/abstract-entity";
export type { EventPolicyDescription } from "./core/event-policy/types/event-policy.interface";
export { coerceTextValues } from "./core/output/coerce";
export {
	compileRoutes,
	HTTP_OPTION_KEYS,
	httpOptionsIssue,
} from "./core/output/http";
export {
	type OperationRoute,
	operationRoutes,
	ROUTE_OPTION_KEYS,
	requestIdHeaderOf,
	routeOptionsIssue,
} from "./core/output/openapi-sink";
export {
	outputValueOf,
	PROBLEM_MEDIA_TYPE,
	problemOf,
} from "./core/output/problem";
export { sinkOf, stageCatalogOf, stageKindOf } from "./core/output/stage";
export { statusOf } from "./core/output/status";
export type {
	Authenticator,
	AuthRequest,
	CompiledRoute,
	CompileRoutesSettings,
	HttpOptions,
	HttpRequest,
	HttpResult,
	RouteTable,
} from "./core/output/types/http.interface";
export type {
	OperationDescriptor,
	Problem,
	ProblemOptions,
	SinkFactory,
	SinkSettings,
	SinkStage,
	StageDescription,
} from "./core/output/types/output.interface";
export { RESERVED_RECORD_KEYS } from "./core/record/abstract-record";
export { SCHEMA_VERSION_KEY } from "./core/repository/state";
export type {
	ProviderCapabilities,
	ProviderDescription,
	ProviderQuery,
} from "./core/repository/types/query.interface";
export type {
	IRepositoryProvider,
	ProviderIncrementOptions,
	ProviderKeyset,
	ProviderMigrationResult,
	ProviderUpdateOptions,
	RepositoryContext,
	RepositoryData,
	RepositorySchema,
} from "./core/repository/types/repository.interface";
export type {
	SchemaChange,
	SchemaChangeClass,
	SchemaChangeKind,
	SchemaLock,
	SchemaLockEntity,
	SchemaLockField,
	SchemaPlan,
} from "./core/repository/types/schema.interface";
export { Demo } from "./core/symbols/demo";
export { Kind } from "./core/symbols/kind";
