/**
 * `@afora/core`: the stable API, what application code imports. Plumbing for
 * sinks, providers and code generators is in `@afora/core/adapters`, features
 * that may still change in `@afora/core/experimental`. A new export goes in
 * the tier `docs/api-tiers.md` describes, and in that table.
 */
export { applicationOf } from "./core/application/application";
export {
	ApplicationAlreadyStarted,
	ApplicationConflict,
	ApplicationNotStarted,
	DuplicateApplicationDeclaration,
	InvalidApplicationDeclaration,
	InvalidApplicationEnvironment,
	InvalidSchemaMigration,
	ProviderNotBound,
	SchemaLockMismatch,
	UnregisteredApplicationReference,
	UnregisteredRepositoryDependency,
	UnregisteredUseCaseDependency,
} from "./core/application/exceptions";
export {
	type ProviderSlot,
	type ProviderStorage,
	providersOf,
} from "./core/application/providers";
export {
	type Register,
	type RegisteredApplication,
	resetApplication,
	useApplication,
} from "./core/application/registry";
export {
	isProviderFactory,
	type LogFactory,
	logFrom,
	type ProviderFactory,
	providerFrom,
} from "./core/application/start";
export type {
	AnyApplication,
	ApplicationCollections,
	ApplicationContext,
	ApplicationRunArgs,
	ApplicationRunOptions,
	ApplicationSettings,
	ApplicationStartOptions,
	IApplication,
} from "./core/application/types/application.interface";
export { blueprintBuilderOf } from "./core/blueprint/blueprint";
export { blueprintPluginOf } from "./core/blueprint/blueprint-plugin";
export {
	InvalidBlueprintVariant,
	ReservedBlueprintKey,
	UndeclaredBlueprintProperty,
} from "./core/blueprint/exceptions";
export { listOf } from "./core/blueprint/list";
export { optionalOf } from "./core/blueprint/optional";
export type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyBlueprintVariant,
	AnyOptionalRecord,
	AnyRecordClass,
	BlueprintBuilder,
	BlueprintContext,
	BlueprintData,
	BlueprintDefinition,
	BlueprintField,
	BlueprintHelpers,
	BlueprintInput,
	BlueprintListOptions,
	BlueprintPluginContext,
	BlueprintSchema,
	BlueprintSource,
	BlueprintValue,
	BlueprintVariants,
	IBlueprint,
	IBlueprintCollection,
	IBlueprintList,
	IBlueprintVariant,
	OptionalBlueprint,
	OptionalBlueprintList,
	OptionalBlueprintVariant,
	OptionalRecord,
} from "./core/blueprint/types/blueprint.interface";
export type {
	BlueprintFactory,
	IBlueprintFactories,
	IBlueprintPlugin,
} from "./core/blueprint/types/blueprint-plugin.interface";
export { variantOf } from "./core/blueprint/variant";
export { commandBuilderOf, isCommand } from "./core/command/command";
export {
	CommandEventFailed,
	InvalidCommandContext,
	InvalidCommandDeclaration,
	InvalidCommandEnvironment,
	UnknownCommandOperation,
} from "./core/command/exceptions";
export type {
	AnyCommand,
	CommandBuilder,
	CommandBuilderSettings,
	CommandEnvOption,
	CommandEventErrorHandler,
	CommandEventHandler,
	CommandEventInfo,
	CommandEvents,
	CommandExecution,
	CommandInput,
	CommandOf,
	CommandOperation,
	CommandOptions,
	CommandResponse,
	CommandSettings,
	CommandUseCases,
	CommandUseCasesOption,
} from "./core/command/types/command.interface";
export {
	EntitySettings,
	EntityUniqueKeys,
} from "./core/entity/abstract-entity";
export { entityBuilderOf, isEntity, isEntityClass } from "./core/entity/entity";
export type {
	AnyEntityClass,
	EntityEvent,
	EntityEventReference,
	EntityEvents,
	EventDefinition,
	EventHandlerContext,
} from "./core/entity/event";
export { eventOf } from "./core/entity/event";
export {
	DeletedEntity,
	ImmutableEntityKey,
	InvalidEntityExpiry,
	InvalidEntitySchemaVersion,
	ReservedEntityKey,
} from "./core/entity/exceptions";
export type {
	DeclaredEntityInstance,
	EntityBuilder,
	EntityBuilderSettings,
	EntityConstructor,
	EntityDuration,
	EntityExpires,
	EntityIdentityKey,
	EntityInput,
	EntityOptions,
	EntityProperties,
	EntityStorageOptions,
	EntityStorageSettings,
	EntityUniqueKey,
	EntityUpgrade,
	EntityUpgrades,
	ExpiresAtField,
	ExpiringIdentity,
	IEntityIdentity,
	IEntityVersion,
	VersionedIdentity,
} from "./core/entity/types/entity.interface";
export { EntityVersion } from "./core/entity/version";
export type {
	AnyEnvironment,
	EnvironmentDependencies,
	EnvironmentOptions,
	EnvironmentSource,
	EnvironmentValue,
	IEnvironment,
} from "./core/environment/environment";
export {
	environmentOf,
	InvalidEnvironment,
} from "./core/environment/environment";
export { eventPolicyOf } from "./core/event-policy/event-policy";
export {
	InvalidEventPolicy,
	PublisherNotBound,
} from "./core/event-policy/exceptions";
export { publishEvents } from "./core/event-policy/publish";
export type {
	EventPolicyFactory,
	EventPolicyOptions,
	EventPolicySettings,
	IEventPolicyCatalog,
	IEventPublisher,
	PublishEventsOptions,
	PublishedEvent,
} from "./core/event-policy/types/event-policy.interface";
export { ExceptionLayers } from "./core/exception/enums/exception-layers";
export type { DeclaredExceptionClass } from "./core/exception/exception";
export { Exception, exceptionOf } from "./core/exception/exception";
export { guard } from "./core/exception/guard";
export type {
	ExceptionArgs,
	ExceptionClass,
	ExceptionDeclaration,
	ExceptionFrame,
	ExceptionInit,
	ExceptionMessage,
	ExceptionPropagation,
	ExceptionScope,
} from "./core/exception/types/exception.interface";
export { InvalidLogDeclaration } from "./core/logger/exceptions";
export type {
	ILogger,
	ILogProvider,
	LogEntry,
	LogFields,
	LoggerDeclaration,
	LogLevel,
	LogProviderSettings,
	LogSettings,
	MemoryLogProvider,
} from "./core/logger/logger";
export {
	consoleLogProvider,
	jsonLogProvider,
	Logger,
	LogLevels,
	logProviderOf,
	memoryLogProvider,
} from "./core/logger/logger";
export { InvalidOpenAPIModel } from "./core/openapi/exceptions";
export { toOpenAPI } from "./core/openapi/openapi";
export type {
	OpenAPIComponents,
	OpenAPIOptions,
	OpenAPISchema,
} from "./core/openapi/types/openapi.interface";
export {
	DuplicateOperation,
	Forbidden,
	InvalidOutputStage,
	Unauthenticated,
} from "./core/output/exceptions";
export type {
	OpenAPIDocument,
	OpenAPIMethod,
	OpenAPISecurityScheme,
	OpenAPISinkOptions,
	RouteOptions,
	RouteStatus,
	SecurityRequirement,
} from "./core/output/openapi-sink";
export { openapi } from "./core/output/openapi-sink";
export { isOutput, operationOf, outputOf } from "./core/output/output";
export type { SelectOptions } from "./core/output/select";
export { select } from "./core/output/select";
export { transformOf } from "./core/output/stage";
export type {
	AnyOutput,
	IStageCatalog,
	OperationCallOptions,
	OperationPatch,
	OutputApplication,
	OutputOf,
	OutputSettings,
	OutputSource,
	OutputStatuses,
	PipeResult,
	Stage,
	StageContext,
	StageFactory,
	StageOptions,
	TransformFactory,
	TransformSettings,
	TransformStage,
} from "./core/output/types/output.interface";
export { stripUndeclared } from "./core/parse/strip";
export type {
	Issue,
	IssueCode,
	ParseResult,
} from "./core/parse/types/parse.interface";
export {
	InvalidPropertyValue,
	PropertyRequired,
} from "./core/property/exceptions";
export type { IPropertyInput } from "./core/property/input";
export { PropertyInput, propertyInputOf } from "./core/property/input";
export type { DeclaredProperty, PropertyClass } from "./core/property/property";
export { propertyOf } from "./core/property/property";
export type { AbstractPropertyConstructor } from "./core/property/types/abstract-property-constructor.type";
export type { IDefineProperty } from "./core/property/types/define-property.interface";
export type { OptionalProperty } from "./core/property/types/optional-property.type";
export type { IProperty } from "./core/property/types/property.interface";
export type {
	AnyPropertyConstructor,
	IPropertyCollection,
} from "./core/property/types/property-collection.type";
export type { PropertyValue } from "./core/property/types/property-constructor.type";
export type {
	CallableProperty,
	NumberConstraints,
	PropertyMetadata,
	PropertyOptions,
	StringConstraints,
} from "./core/property/types/property-options.interface";
export type {
	IPropertyType,
	SensitiveMark,
	UniqueMark,
} from "./core/property/types/property-type.interface";
export {
	IncompatibleRecordPlugin,
	InvalidRecordDeclaration,
	InvalidRecordPlugin,
	InvalidRecordValue,
	RecordPluginConflict,
	ReservedRecordKey,
	UndeclaredRecordProperty,
	UnknownRecordPlugin,
} from "./core/record/exceptions";
export { MASK } from "./core/record/mask";
export { recordNameOf } from "./core/record/name";
export { hasPlugin, pluginsOf, recordPluginOf } from "./core/record/plugin";
export { recordPluginCatalogOf } from "./core/record/plugin-catalog";
export type { RecordBuilder } from "./core/record/record";
export { recordBuilderOf } from "./core/record/record";
export type {
	AnyRecordPlugin,
	IRecordPlugin,
	IRecordPluginCatalog,
	PluginUniqueKey,
	RecordPluginDescriptor,
	RecordPluginOptions,
	RecordPluginReference,
	RecordPluginRequirement,
	RecordPluginsOption,
} from "./core/record/types/plugin.interface";
export type {
	DeclaredRecordInstance,
	IRecord,
	MarkedUniqueKey,
	Masked,
	RecordChange,
	RecordChanges,
	RecordConstructor,
	RecordEffect,
	RecordEffects,
	RecordJson,
	RecordKey,
	RecordOptions,
	RecordSettings,
	RecordValue,
} from "./core/record/types/record.interface";
export {
	InvalidRepositoryCursor,
	InvalidRepositoryData,
	InvalidRepositoryDeclaration,
	InvalidRepositoryEntity,
	InvalidRepositoryIncrement,
	InvalidRepositoryQuery,
	InvalidStoredSchemaVersion,
	RepositoryConcurrencyConflict,
	RepositoryEntityNotFound,
	RepositoryUniqueViolation,
	RepositoryUsedOutsideApplication,
} from "./core/repository/exceptions";
export {
	type InMemoryProvider,
	inMemoryProvider,
} from "./core/repository/in-memory";
export { providerOf } from "./core/repository/provider";
export type { RepositorySettings } from "./core/repository/repository";
export { RepositoryOf, repositoryOf } from "./core/repository/repository";
export type {
	ProviderOption,
	ProviderOptions,
	ProviderSettings,
	RepositoryCursorPage,
	RepositoryCursorQuery,
	RepositoryExists,
	RepositoryExplain,
	RepositoryFindCursor,
	RepositoryFindMany,
	RepositoryFindPage,
	RepositoryForEachPage,
	RepositoryIndex,
	RepositoryOrder,
	RepositoryPage,
	RepositoryPlan,
	RepositoryQuery,
	RepositoryScans,
	RepositoryWalkOptions,
	RepositoryWalkPage,
	RepositoryWalkResult,
	RepositoryWhere,
} from "./core/repository/types/query.interface";
export type {
	AnyRepository,
	AnyRepositoryEntity,
	EntityIncrementKeyOf,
	EntityInstanceOf,
	EntityKeyOf,
	EntityNonUniqueKeyOf,
	EntityUniqueKeyOf,
	EntityValueOf,
	QueryValueOf,
	RepositoryAction,
	RepositoryCount,
	RepositoryCreate,
	RepositoryCreateInput,
	RepositoryDelete,
	RepositoryFindBy,
	RepositoryFindManyBy,
	RepositoryIncrement,
	RepositoryIncrementDeltas,
	RepositoryIncrementOptions,
	RepositoryRestore,
	RepositoryUpdate,
} from "./core/repository/types/repository.interface";
export type {
	EntityMigrationReport,
	SchemaMigrationInvalidRow,
	SchemaMigrationOptions,
	SchemaMigrationReport,
} from "./core/repository/types/schema.interface";
export type {
	ISchema,
	ISchemaType,
} from "./core/schema/types/schema.interface";
export type { StandardSchemaV1 } from "./core/standard/standard-schema";
export { Meta } from "./core/symbols/meta";
export { State } from "./core/symbols/state";
export { InvalidTraceDeclaration } from "./core/tracing/exceptions";
export type {
	ITracer,
	ITraceSpan,
	MemorySpan,
	MemoryTracer,
	TraceAttributes,
	TraceStatus,
} from "./core/tracing/tracing";
export { memoryTracer } from "./core/tracing/tracing";
export { Access, Route } from "./core/use-case/decorators";
export {
	IncompatibleUseCasePlugin,
	InvalidUseCasePlugin,
	InvalidUseCaseStep,
	UnknownUseCasePlugin,
	UseCaseEntityConflict,
	UseCaseEntityNotFound,
	UseCaseInvalidCredentials,
	UseCaseUnavailable,
} from "./core/use-case/exceptions";
export { isUseCasePlugin, useCasePluginOf } from "./core/use-case/plugin";
export {
	isUseCaseCatalog,
	useCaseCatalogOf,
} from "./core/use-case/plugin-catalog";
export type {
	CheckedSteps,
	StepReferencesOf,
	StepReferenceType,
	StepsInitialScope,
	StepValueCheck,
} from "./core/use-case/steps/types/check.interface";
export type {
	StepArgs,
	StepEnsureKind,
	StepErrorDescription,
	StepFindTarget,
	StepReadAction,
	StepReference,
	StepRepositoryWith,
	StepValue,
	UseCaseStep,
	UseCaseStepDescription,
} from "./core/use-case/steps/types/steps.interface";
export type {
	AccessDeclaration,
	Principal,
} from "./core/use-case/types/access.interface";
export type {
	AnyUseCasePlugin,
	EntityOfRepository,
	IUseCaseCatalog,
	IUseCasePlugin,
	MissingRecordPlugin,
	MissingRepositoryAction,
	UseCaseCompilation,
	UseCaseFieldPlan,
	UseCaseMaker,
	UseCasePluginDescriptor,
	UseCasePluginRequirements,
	UseCasePluginSettings,
	UseCaseTarget,
	UseCaseTargetInfo,
} from "./core/use-case/types/plugin.interface";
export type {
	RouteDeclaration,
	RouteSettings,
} from "./core/use-case/types/route.interface";
export type {
	AnyExceptionClass,
	AnyUseCaseClass,
	DependencyFunctions,
	DependencyOf,
	DependencyOverrides,
	StepsUseCaseConstructor,
	UseCaseCollection,
	UseCaseConstructor,
	UseCaseContext,
	UseCaseDeclaration,
	UseCaseDependencies,
	UseCaseDependency,
	UseCaseInput,
	UseCaseOptions,
	UseCaseResponse,
	UseCaseSettings,
	UseCaseStepsSettings,
} from "./core/use-case/use-case";
export {
	InvalidUseCaseDeclaration,
	InvalidUseCaseDependencies,
	isUseCase,
	isUseCaseClass,
	UseCaseAlreadyExecuted,
	useCaseOf,
} from "./core/use-case/use-case";
export { blueprintOf } from "./std/blueprint";
export { Std } from "./std/blueprint-plugin";
export { commandOf } from "./std/command";
export { entityOf } from "./std/entity";
export { StdEventPolicies } from "./std/event-policies";
export { Email, Ip, Phone, Url } from "./std/properties/contact";
export type { EnumClass } from "./std/properties/enum";
export { enumOf } from "./std/properties/enum";
export {
	InvalidJsonData,
	InvalidJsonSchema,
} from "./std/properties/exceptions";
export { SchemaProperty } from "./std/properties/headless";
export { Id, Slug } from "./std/properties/identity";
export type { JsonClass, JsonValue } from "./std/properties/json";
export {
	checkJsonSchema,
	JsonProperty,
	jsonOf,
	jsonSchemaIssues,
} from "./std/properties/json";
export { Password, PlainPassword } from "./std/properties/password";
export {
	BooleanProperty,
	Integer,
	NumberProperty,
	StringProperty,
	Text,
} from "./std/properties/primitives";
export {
	CreatedAt,
	DateProperty,
	DateTime,
	DeletedAt,
	ExpiresAt,
	UpdatedAt,
} from "./std/properties/time";
export { recordOf } from "./std/record";
export {
	Archivable,
	Authenticatable,
	Ownable,
	Publishable,
	StdRecordPlugins,
	Taggable,
} from "./std/record-plugins";
export { resourceOf } from "./std/resource";
export type {
	IdGenerator,
	PasswordHasher,
	RuntimeServices,
} from "./std/runtime";
export {
	configure,
	PasswordHasherRequired,
	resetRuntime,
	SyncVerifyUnsupported,
} from "./std/runtime";
export { StdStages } from "./std/stages";
export { StdUseCases } from "./std/use-cases/index";
export type {
	ArchiveMaker,
	CreateMaker,
	DeleteMaker,
	GetMaker,
	ListMaker,
	LoginMaker,
	PublishMaker,
	RegisterMaker,
	ResourceAction,
	ResourceOptions,
	ResourceUseCases,
	RestoreMaker,
	StdCreateOptions,
	StdEntityOptions,
	StdHookArgs,
	StdHookOptions,
	StdLifecycleOptions,
	StdListOptions,
	StdNoHookOptions,
	StdOwnerOption,
	StdUseCaseContext,
	StdUseCaseErrors,
	StdUseCaseOptions,
	StdUseCasePlugins,
	TagMaker,
	UpdateMaker,
} from "./std/use-cases/types";
