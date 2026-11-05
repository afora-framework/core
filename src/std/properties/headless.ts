import { type TSchema, Type } from "typebox";
import { Meta } from "typebox/schema";
import { InvalidPropertyValue } from "../../core/property/exceptions";
import { propertyOf } from "../../core/property/property";
import { schemaOf } from "../../core/schema/schema";
import type { ISchema } from "../../core/schema/types/schema.interface";

/** A JSON Schema (draft 2020-12) object; boolean schemas are not accepted. */
const JSON_SCHEMA = Type.Unsafe<TSchema>({
	type: "object",
	allOf: [Meta["https://json-schema.org/draft/2020-12/schema"]],
});

/**
 * A TypeBox schema held as a value, e.g. the shape of a content type defined
 * at runtime. `serialize` and `SchemaProperty.deserialize` move it to and
 * from JSON, and `match`/`errors` validate data against it.
 */
export class SchemaProperty extends propertyOf({
	name: "schema",
	schema: JSON_SCHEMA,
	default: Type.String(),
}) {
	private compiled?: ISchema<TSchema>;

	/** Parses a schema written by `serialize`. */
	static deserialize(json: string): SchemaProperty {
		let value: unknown;
		try {
			value = JSON.parse(json);
		} catch (error) {
			throw new InvalidPropertyValue({
				source: "schema",
				details: { errors: [(error as Error).message] },
			});
		}

		return new SchemaProperty(value as TSchema);
	}

	serialize(): string {
		return JSON.stringify(this.value);
	}

	/** Whether `data` is valid for the held schema. */
	match(data: unknown): boolean {
		return this.toSchema().match(data);
	}

	errors(data: unknown): string[] {
		return this.toSchema().errors(data);
	}

	private toSchema(): ISchema<TSchema> {
		if (!this.compiled) {
			const Schema = schemaOf("schema", this.value);
			this.compiled = new Schema();
		}
		return this.compiled;
	}
}
