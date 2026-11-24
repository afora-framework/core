import { type TSchema, Type } from "typebox";
import { Meta } from "typebox/schema";
import { takesAnyValue } from "../../core/property/define-property";
import { InvalidPropertyValue } from "../../core/property/exceptions";
import { propertyOf } from "../../core/property/property";
import { schemaOf } from "../../core/schema/schema";
import type { ISchema } from "../../core/schema/types/schema.interface";
import { assertHeldSchema, MAX_SCHEMA_DEPTH } from "./held-schema";
import { assertDepth } from "./json";

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
	// The depth first, of any value: the check of the shape walks it all.
	// Then what checking data against it costs: its references and patterns.
	preHandle: takesAnyValue(
		(value: TSchema): TSchema =>
			assertHeldSchema(assertDepth(value, MAX_SCHEMA_DEPTH)),
	),
}) {
	private compiled?: ISchema<TSchema>;

	/** Parses a schema written by `serialize`. */
	static deserialize(json: string): SchemaProperty {
		let value: unknown;
		try {
			// The depth first: the check of the schema walks it all.
			value = assertDepth(JSON.parse(json), MAX_SCHEMA_DEPTH);
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
