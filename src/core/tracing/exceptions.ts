import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** The `trace` of an application is not a tracer (`ITracer`). */
export const InvalidTraceDeclaration = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "InvalidTraceDeclaration",
	message: ({ reason }: { readonly reason: string }) => reason,
});
