import type { Static, TSchema } from "typebox";
import type { Validator } from "typebox/compile";

export type ISchemaType<SchemaType extends TSchema> = Validator<
	Record<string, TSchema>,
	SchemaType
>;

export interface ISchema<SchemaType extends TSchema> {
	match(value: unknown): value is Static<SchemaType>;
	/**
	 * Whether `value` has the structure of the schema (its types), ignoring
	 * constraints such as `minLength`, `format`, `pattern` or `const`.
	 */
	matchShape(value: unknown): boolean;
	errors(value: unknown): string[];
	toString(): string;
	get type(): ISchemaType<SchemaType>;
}
