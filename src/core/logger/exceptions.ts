import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `logProviderOf`, `logFrom` or the `log` of an application got something it cannot use. */
export const InvalidLogDeclaration = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "InvalidLogDeclaration",
	message: ({ reason }: { readonly reason: string }) => reason,
});
