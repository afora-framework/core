import { commandBuilderOf } from "../core/command/command";
import type { CommandBuilder } from "../core/command/types/command.interface";
import { StdUseCases } from "./use-cases/index";
import type { StdUseCaseContext } from "./use-cases/types";

/**
 * Groups use cases under operation names and is the boundary of a call: the
 * context is validated once, a transaction can wrap the use case, and the
 * events it raised are handled by a policy once it succeeded. `useCases` is
 * an object of use case classes, or a function of the standard use cases
 * (`StdUseCases`) that gives one:
 * `(ctx) => ({ create: ctx.create(Posts), custom: MyUseCase })`.
 */
export const commandOf: CommandBuilder<StdUseCaseContext> = commandBuilderOf(
	StdUseCases,
) as unknown as CommandBuilder<StdUseCaseContext>;
