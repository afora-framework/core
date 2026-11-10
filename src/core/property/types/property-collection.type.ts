import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { AbstractProperty } from "../abstract-property";
import type { IPropertyType } from "./property-type.interface";

/**
 * Any property declaration, subclasses included: `PropertyValue<any>` resolves
 * to `unknown`, which a constructor taking a narrower value would reject.
 */
export type AnyPropertyConstructor = {
	// biome-ignore lint/suspicious/noExplicitAny: any property, whatever its schema
	new (value: any): AbstractProperty<any, any>;
	// biome-ignore lint/suspicious/noExplicitAny: see above
	readonly type: IPropertyType<any, any>;
	// biome-ignore lint/suspicious/noExplicitAny: see above
	safeParse(value: unknown): ParseResult<any>;
	// biome-ignore lint/suspicious/noExplicitAny: see above
	readonly "~standard": StandardSchemaV1.Props<any, any>;
};

/** Property declarations by key, e.g. `{ name: Name, email: Email }`. */
export type IPropertyCollection = Record<string, AnyPropertyConstructor>;
