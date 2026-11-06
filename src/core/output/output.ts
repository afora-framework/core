import { isCommand } from "../command/command";
import type { AnyCommand } from "../command/types/command.interface";
import { Kind } from "../symbols/kind";
import type { AnyUseCaseClass } from "../use-case/use-case";
import { DuplicateOperation, InvalidOutputStage } from "./exceptions";
import { isStage } from "./stage";
import type {
	AnyOutput,
	OperationDescriptor,
	OperationPatch,
	OutputOf,
	OutputSettings,
	OutputStatuses,
	PipeResult,
	SinkStage,
	Stage,
	StageContext,
} from "./types/output.interface";

function invalid(source: string, reason: string): never {
	throw new InvalidOutputStage({ source, details: { reason } });
}

const PATCHABLE = ["meta", "tags", "description", "deprecated", "invoke"];

/**
 * A modified copy of `operation`. Only `meta` (replaced), `tags`,
 * `description`, `deprecated` and `invoke` can change; `kind`, `version`,
 * `id`, `command`, `name`, `useCase`, `input`, `response`, `context` and
 * `errors` cannot, and a patch naming them throws `InvalidOutputStage`.
 */
export function operationOf(
	operation: OperationDescriptor,
	patch: OperationPatch,
): OperationDescriptor {
	const source = operation?.id ?? "operationOf";
	if (operation?.kind !== "operation" || operation.version !== 1) {
		invalid(source, "Expected an operation descriptor.");
	}
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		invalid(source, "Expected the patch to be an object.");
	}
	for (const key of Reflect.ownKeys(patch)) {
		if (typeof key !== "string" || !PATCHABLE.includes(key)) {
			invalid(
				source,
				`"${String(key)}" cannot be patched; only ${PATCHABLE.join(", ")} can.`,
			);
		}
	}
	const { meta, tags, description, deprecated, invoke } = patch;
	if (
		"meta" in patch &&
		(typeof meta !== "object" || meta === null || Array.isArray(meta))
	) {
		invalid(source, "Expected meta to be an object.");
	}
	if (
		"tags" in patch &&
		(!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
	) {
		invalid(source, "Expected tags to be a list of strings.");
	}
	if (
		"description" in patch &&
		description !== undefined &&
		typeof description !== "string"
	) {
		invalid(source, "Expected description to be a string.");
	}
	if ("deprecated" in patch && typeof deprecated !== "boolean") {
		invalid(source, "Expected deprecated to be a boolean.");
	}
	if ("invoke" in patch && typeof invoke !== "function") {
		invalid(source, "Expected invoke to be a function.");
	}
	return Object.freeze({
		...operation,
		...("meta" in patch ? { meta: Object.freeze({ ...meta }) } : {}),
		...("tags" in patch ? { tags: Object.freeze([...(tags ?? [])]) } : {}),
		...("description" in patch ? { description } : {}),
		...("deprecated" in patch ? { deprecated } : {}),
		...("invoke" in patch ? { invoke } : {}),
	});
}

/** The operations of one command, in declaration order. */
function operationsOfCommand(command: AnyCommand): OperationDescriptor[] {
	return (command.operations as readonly string[]).map((name) => {
		const UseCase = command.useCases[name] as AnyUseCaseClass;
		const context = command.context ?? UseCase.context;
		const description = UseCase.description ?? command.description;
		return Object.freeze({
			kind: "operation" as const,
			version: 1 as const,
			id: `${command.commandName}.${name}`,
			command: command.commandName,
			name,
			useCase: UseCase.useCaseName,
			...(description === undefined ? {} : { description }),
			tags: Object.freeze([
				...new Set<string>([...command.tags, ...UseCase.tags]),
			]),
			deprecated: UseCase.deprecated,
			input: UseCase.blueprint,
			response: UseCase.response,
			...(context ? { context } : {}),
			errors: UseCase.errors,
			meta: Object.freeze({}),
			invoke: (input: unknown, options?: { context?: unknown }) =>
				(
					command.run as (
						op: string,
						input: unknown,
						options?: { context?: unknown },
					) => Promise<unknown>
				)(name, input, options),
		});
	});
}

function statusesOf(name: string, statuses: unknown): OutputStatuses {
	if (statuses === undefined) return Object.freeze({});
	if (
		typeof statuses !== "object" ||
		statuses === null ||
		Array.isArray(statuses)
	) {
		invalid(
			name,
			"Expected statuses to be a map of exception names to statuses.",
		);
	}
	for (const [exception, status] of Object.entries(statuses)) {
		if (
			!exception ||
			typeof status !== "number" ||
			!Number.isInteger(status) ||
			status < 400 ||
			status > 599
		) {
			invalid(
				name,
				`Expected the status of "${exception}" to be an integer between 400 and 599.`,
			);
		}
	}
	return Object.freeze({ ...(statuses as OutputStatuses) });
}

function checkPipe(name: string, pipe: unknown): readonly Stage[] {
	if (!Array.isArray(pipe))
		invalid(name, "Expected pipe to be a list of stages.");
	const stages = pipe as unknown[];
	stages.forEach((stage, index) => {
		if (!isStage(stage)) {
			invalid(name, `Expected pipe[${index}] to be a transform or sink stage.`);
		}
		if (stage.kind === "sink" && index !== stages.length - 1) {
			invalid(name, `The sink at pipe[${index}] must be the last stage.`);
		}
	});
	return Object.freeze([...(stages as Stage[])]);
}

/** Runs `transforms` over `operations`; `null` removes an operation. */
function transformed(
	name: string,
	operations: readonly OperationDescriptor[],
	transforms: readonly Stage[],
	context: StageContext,
): readonly OperationDescriptor[] {
	let current = operations;
	for (const stage of transforms) {
		if (stage.kind !== "transform") continue;
		const next: OperationDescriptor[] = [];
		for (const operation of current) {
			const result = stage.apply(operation, context);
			if (result === null) continue;
			if (
				typeof result !== "object" ||
				result?.kind !== "operation" ||
				result.id !== operation.id
			) {
				invalid(
					name,
					`A transform must return the operation "${operation.id}" or null.`,
				);
			}
			next.push(result);
		}
		current = next;
	}
	return Object.freeze([...current]);
}

function make(
	name: string,
	commands: readonly AnyCommand[],
	operations: readonly OperationDescriptor[],
	stages: readonly Stage[],
	statuses: OutputStatuses,
): AnyOutput {
	const context: StageContext = Object.freeze({
		output: Object.freeze({ name, statuses }),
	});
	let built: { readonly value: unknown } | undefined;
	const output = {
		[Kind]: "output",
		outputName: name,
		commands,
		operations,
		stages,
		statuses,
		build() {
			if (built) return built.value;
			const sink = stages.at(-1);
			if (sink?.kind !== "sink") {
				invalid(name || "output", "The pipe has no sink to build.");
			}
			built = { value: (sink as SinkStage).build(operations, context) };
			return built.value;
		},
		pipe(...more: Stage[]) {
			const next = checkPipe(name || "output", more);
			const last = next.at(-1);
			if (stages.at(-1)?.kind === "sink") {
				invalid(name || "output", "Cannot add stages after the sink.");
			}
			const ops = transformed(name, operations, next, context);
			if (last?.kind === "sink") {
				return last.build(ops, context);
			}
			return make(
				"",
				commands,
				ops,
				Object.freeze([...stages, ...next]),
				statuses,
			);
		},
	};
	return Object.freeze(output) as unknown as AnyOutput;
}

/**
 * An output turns commands into operations and runs them through a pipe of
 * stages: transforms change them, and a last sink builds something concrete
 * (an OpenAPI document, an HTTP app, ...). The operations are computed once,
 * at declaration; `build()` runs the sink the first time it is called.
 * Throws `InvalidOutputStage` (or `DuplicateOperation`) for a bad declaration.
 *
 * TODO: accept an application (`commands: app`) when `applicationOf` supports outputs.
 */
export function outputOf<const Pipe extends readonly Stage[] = readonly []>(
	settings: OutputSettings<Pipe>,
): OutputOf<PipeResult<Pipe>> {
	const { name, commands } = settings ?? ({} as OutputSettings<Pipe>);
	if (typeof name !== "string" || !name.trim()) {
		invalid("outputOf", "Expected name to be a non-empty string.");
	}
	if (!Array.isArray(commands) || commands.some((entry) => !isCommand(entry))) {
		invalid(
			name,
			"Expected commands to be a list of commands made by commandOf (applications are not supported yet).",
		);
	}
	const statuses = statusesOf(name, settings.statuses);
	const stages = checkPipe(name, settings.pipe ?? []);
	const all = commands.flatMap(operationsOfCommand);
	const ids = new Set<string>();
	for (const { id } of all) {
		if (ids.has(id))
			throw new DuplicateOperation({ source: name, details: { id } });
		ids.add(id);
	}
	const context: StageContext = { output: { name, statuses } };
	const operations = transformed(name, all, stages, context);
	return make(
		name,
		Object.freeze([...commands]),
		operations,
		stages,
		statuses,
	) as unknown as OutputOf<PipeResult<Pipe>>;
}

/** Whether `value` is an output made by `outputOf`. */
export function isOutput(value: unknown): value is AnyOutput {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "output"
	);
}
