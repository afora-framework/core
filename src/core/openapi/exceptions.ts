import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `toOpenAPI` is given something that is not a field: a property, blueprint, list, record or entity. */
export const InvalidOpenAPIModel = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidOpenAPIModel",
	message: ({ name }: { readonly name: string }) =>
		`"${name}" is not a property, blueprint, list, record or entity.`,
});
