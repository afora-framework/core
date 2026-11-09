import { isPlain } from "./references";
import type {
	StepErrorDescription,
	UseCaseStepDescription,
} from "./types/steps.interface";

/** How a class of a step is named in the descriptor. */
export interface StepNames {
	/** The registered name of a record or entity class. */
	readonly record: (Class: unknown) => string;
	/** The registered name of an exception, or `{ core }` for one the package exports. */
	readonly error: (Class: unknown) => StepErrorDescription;
}

/** A copy of JSON data, so that nothing in the descriptor is shared with the declaration. */
function cloneData<Value>(value: Value): Value {
	if (Array.isArray(value)) return value.map(cloneData) as Value;
	if (isPlain(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, cloneData(item)]),
		) as Value;
	}
	return value;
}

/**
 * The steps as `describe()` gives them: the same data, with the classes of
 * `build` and `ensure.error` by name and the function of `run` as `opaque`.
 */
export function describeSteps(
	steps: readonly Readonly<Record<string, unknown>>[],
	names: StepNames,
): UseCaseStepDescription[] {
	return steps.map((step) => {
		const copy = cloneData({ ...step }) as Record<string, unknown>;
		if (Object.hasOwn(step, "build")) copy.build = names.record(step.build);
		if (Object.hasOwn(step, "ensure")) copy.error = names.error(step.error);
		if (Object.hasOwn(step, "run")) copy.fn = { kind: "opaque" };
		return copy as unknown as UseCaseStepDescription;
	});
}
