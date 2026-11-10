import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `outputOf`, an operation patch or a stage got something it cannot use; `details.reason` says what. */
export const InvalidOutputStage = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidOutputStage",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** Two operations of an output share an id. */
export const DuplicateOperation = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "DuplicateOperation",
	message: ({ id }: { readonly id: string }) =>
		`The operation "${id}" is declared twice.`,
});
