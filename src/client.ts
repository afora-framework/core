/**
 * `@afora/core/client`: what a client needs to declare blueprints and parse
 * values, without the modules only a server runs (records, entities,
 * repositories, use cases, outputs, logging, tracing). The same objects as
 * `@afora/core`: a blueprint made from either entry is accepted by the other.
 * Part of the compatibility policy in `VERSIONING.md`, like the main entry.
 * See `docs/api-tiers.md`.
 */

export { listOf } from "./core/blueprint/list";
export { optionalOf } from "./core/blueprint/optional";
export type { AnyParsable } from "./core/blueprint/types/blueprint.interface";
export { variantOf } from "./core/blueprint/variant";
export { ExceptionLayers } from "./core/exception/enums/exception-layers";
export { exceptionOf } from "./core/exception/exception";
export type {
	Issue,
	IssueCode,
	ParseResult,
} from "./core/parse/types/parse.interface";
export { propertyOf } from "./core/property/property";
export type { StandardSchemaV1 } from "./core/standard/standard-schema";
export { blueprintOf } from "./std/blueprint";
export { enumOf } from "./std/properties/enum";
