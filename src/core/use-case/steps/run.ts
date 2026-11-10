import { isRecordClass } from "../../blueprint/record-field";
import { sameValue } from "../../repository/query";
import { InvalidUseCaseStep } from "../exceptions";
import { followPath, type ParsedReference, resolveValue } from "./references";

type Step = Readonly<Record<string, unknown>>;
type Method = (...args: unknown[]) => unknown;

/** What the interpreter reads of the use case it runs for. */
interface Host {
	readonly input: unknown;
	readonly context: unknown;
	readonly constructor: {
		readonly useCaseName: string;
		readonly steps?: readonly Step[];
	};
}

/** The members no `invoke` may call: the ones a record keeps protected, and those of every object. */
const FORBIDDEN_METHODS = new Set([
	"set",
	"emit",
	"constructor",
	"__proto__",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"valueOf",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

function isRecordInstance(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		isRecordClass((value as { constructor?: unknown }).constructor)
	);
}

/**
 * The `execute` of a use case declared with `steps`: runs them in order, each
 * awaited, over the dependencies `execute` resolved, so that scope, events and
 * trace frames work as in a hand-written `execute`. The wrapper of the
 * constructor validates the response `return` gives.
 */
export async function executeSteps(
	this: Host,
	dependencies: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
	const { useCaseName, steps = [] } = this.constructor;
	const named = new Map<string, unknown>();
	const lookup = ({ root, path }: ParsedReference): unknown => {
		if (root === "input") return followPath(this.input, path);
		if (root === "context") return followPath(this.context, path);
		if (root === "env")
			return followPath(dependencies[path[0] as string], path.slice(1));
		return followPath(named.get(root), path);
	};
	const value = (raw: unknown): unknown => resolveValue(raw, lookup);

	for (const [index, step] of steps.entries()) {
		const invalid = (reason: string): never => {
			throw new InvalidUseCaseStep({
				source: useCaseName,
				details: { index, reason, code: "invalid_target" },
			});
		};
		const list = (raw: unknown): unknown[] => {
			if (raw === undefined) return [];
			const resolved = value(raw);
			if (!Array.isArray(resolved)) invalid("args must resolve to a list.");
			return resolved as unknown[];
		};
		const bind = (result: unknown): void => {
			if (typeof step.as === "string") named.set(step.as, result);
		};
		const target = (field: string): Record<string, unknown> => {
			const resolved = value(step[field]);
			if (!isRecordInstance(resolved)) {
				invalid(`${field} must reference a record or entity.`);
			}
			return resolved as Record<string, unknown>;
		};

		if (Object.hasOwn(step, "return")) return value(step.return);

		if (Object.hasOwn(step, "find")) {
			const [repository, action] = (step.find as string).split(".") as [
				string,
				string,
			];
			const methods = dependencies[repository] as Record<string, Method>;
			bind(await (methods[action] as Method).call(methods, ...list(step.args)));
		} else if (Object.hasOwn(step, "ensure")) {
			const subject = value(step.value);
			const passed = {
				exists: subject !== undefined && subject !== null,
				absent: subject === undefined || subject === null,
				equals: sameValue(subject, value(step.other)),
				notEquals: !sameValue(subject, value(step.other)),
				true: subject === true,
				false: subject === false,
			}[step.ensure as string];
			if (!passed) {
				const Thrown = step.error as new (init: {
					source: string;
					details?: unknown;
				}) => Error;
				throw new Thrown({
					source: useCaseName,
					...(step.details === undefined
						? {}
						: { details: value(step.details) }),
				});
			}
		} else if (Object.hasOwn(step, "build")) {
			const Built = step.build as new (values: unknown) => object;
			bind(new Built(value(step.values)));
		} else if (Object.hasOwn(step, "change")) {
			const record = target("change");
			const namespace = record.change as Record<string, Method> | undefined;
			const key = step.key as string;
			if (
				typeof namespace !== "object" ||
				namespace === null ||
				typeof namespace[key] !== "function"
			) {
				invalid(`"${key}" is not a change key of the record.`);
			}
			const changed = value(step.value);
			if (step.ifPresent !== true || changed !== undefined) {
				await (namespace as Record<string, Method>)[key]?.(changed);
			}
			bind(record);
		} else if (Object.hasOwn(step, "invoke")) {
			const record = target("invoke");
			const method = step.method as string;
			if (
				FORBIDDEN_METHODS.has(method) ||
				typeof record[method] !== "function"
			) {
				invalid(`"${method}" is not a public method of the record.`);
			}
			bind(await (record[method] as Method).apply(record, list(step.args)));
		} else if (Object.hasOwn(step, "call")) {
			const child = dependencies[step.call as string] as Method;
			bind(await child(value(step.input)));
		} else if (Object.hasOwn(step, "run")) {
			const fn = step.fn as Method;
			bind(
				await fn(...list(step.args), { context: this.context, dependencies }),
			);
		} else {
			// create, update, delete or restore
			const action = ["create", "update", "delete", "restore"].find((kind) =>
				Object.hasOwn(step, kind),
			) as string;
			const methods = dependencies[step[action] as string] as Record<
				string,
				Method
			>;
			bind(await (methods[action] as Method).call(methods, value(step.value)));
		}
	}
	return undefined;
}

/** The steps a use case class interprets; `undefined` when its `execute` is hand-written. */
export function interpretedStepsOf(
	UseCase: unknown,
): readonly Readonly<Record<string, unknown>>[] | undefined {
	const Declared = UseCase as {
		readonly prototype: { readonly execute: unknown };
		readonly steps?: readonly Step[];
	};
	return Declared.prototype.execute === executeSteps
		? Declared.steps
		: undefined;
}
