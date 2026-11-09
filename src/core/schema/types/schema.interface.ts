import type { Static, TSchema } from "typebox";
import type { Validator } from "typebox/compile";

/**
 * The compiled validator of a schema. `Value` is the schema's value, computed
 * once where `SchemaType` is known: TypeScript then relates two of them by
 * their values, without measuring `Static` itself, which costs about a second
 * on every check.
 */
export type ISchemaType<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> = Validator<Record<string, TSchema>, SchemaType, Value, Value>;

/** A schema; `Value` is its value, as in `ISchemaType`. */
export interface ISchema<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> {
	match(value: unknown): value is Value;
	/**
	 * Whether `value` has the structure of the schema (its types), ignoring
	 * constraints such as `minLength`, `format`, `pattern` or `const`.
	 */
	matchShape(value: unknown): boolean;
	errors(value: unknown): string[];
	toString(): string;
	get type(): ISchemaType<SchemaType, Value>;
}
