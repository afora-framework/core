import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/**
 * A step of a use case is invalid: at declaration (`useCaseOf({ steps })`),
 * or while the steps run (a `change` or `invoke` on something that is not a
 * record or has no such member). `details.index` is the position of the step.
 */
export const InvalidUseCaseStep = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidUseCaseStep",
	message: ({
		index,
		reason,
	}: {
		readonly index: number;
		readonly reason: string;
		readonly code?: string;
	}) => `Invalid step ${index}: ${reason}`,
});
