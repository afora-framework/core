export {
	type Catalog,
	catalog,
	type FactoryInfo,
	type RecordPluginInfo,
	type SchemaKind,
	type StdPropertyInfo,
} from "./catalog";
export { ExtractionError, type ExtractOptions, extractSpec } from "./extract";
export {
	BANNER,
	GENERATED_FILES,
	type GeneratedFile,
	generate,
	InvalidSpecError,
} from "./generate";
export {
	type LoadedSpec,
	loadSpec,
	referenceToPath,
	resolveExtended,
	SpecLoadError,
} from "./load";
export { compactSpec, normalizeSpec } from "./normalize";
export { declarationSchemas, fieldDefinition, specSchema } from "./spec/schema";
export type {
	BlueprintSpec,
	CodegenOptions,
	EnumField,
	EnumValue,
	EnvironmentSpec,
	FieldSpec,
	FieldsSpec,
	ImportRef,
	InlineField,
	ListBounds,
	PropertySpec,
	ProviderCatalogEntry,
	ProviderOptionSpec,
	ProviderSpec,
	RecordSpec,
	RepositorySpec,
	ResolvedSpec,
	Spec,
	SpecIssue,
	TypeField,
	WithOptions,
} from "./spec/types";
export { COLLECTIONS as COLLECTION_KEYS } from "./spec/types";
export { validateSpec } from "./validate";
export {
	confinePath,
	isGenerated,
	type RefusedFile,
	type WriteOptions,
	type WriteResult,
	writeGenerated,
} from "./write";
