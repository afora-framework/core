import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** A required property got `undefined`; `source` is the property name. */
export const PropertyRequired = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "PropertyRequired",
	message: (_, source) => `Property "${source}" is required.`,
});

/** A property got a value its rules reject; `source` is the property name. */
export const InvalidPropertyValue = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "InvalidPropertyValue",
	message: ({ errors }: { readonly errors: readonly string[] }, source) =>
		`Invalid value for property "${source}": ${errors.join("; ")}`,
});
