import type { Static, TSchema } from "typebox";
import { Exception } from "../exception/exception";
import { type IssueOrigin, LazyIssue, REJECTED } from "../parse/issue";
import type {
	Issue,
	IssueCode,
	ParseResult,
} from "../parse/types/parse.interface";
import {
	describeError,
	errorsOfSchema,
	type SchemaError,
} from "../schema/schema";
import { State } from "../symbols/state";
import { PropertyStates } from "./enums/property-states";
import { InvalidPropertyValue, PropertyRequired } from "./exceptions";
import type { IDefineProperty } from "./types/define-property.interface";
import type { IPropertyType } from "./types/property-type.interface";

/** What `handle` gives back for a value the schema rejects. */
const MISMATCH = Symbol("mismatch");

/**
 * Why a value stopped the pipeline: the exception `make` throws, built the
 * first time it is asked for and kept, and what the issues `parse` returns
 * are made of.
 */
class Failure implements IssueOrigin {
	private cause: Exception | undefined;

	constructor(
		/** The name of the property. */
		readonly source: string,
		/** The exception a step threw, which is the `cause` of the issue as it is. */
		readonly raised: Exception | undefined,
		/** The errors of the schema, when it rejected the value. */
		readonly errors: readonly SchemaError[] | undefined,
	) {
		this.cause = raised;
	}

	exception(): Exception {
		if (this.cause === undefined) {
			const { source, errors } = this;
			this.cause = errors
				? new InvalidPropertyValue({
						source,
						details: { errors: errors.map(describeError) },
					})
				: new PropertyRequired({ source });
		}
		return this.cause;
	}
}

/**
 * The failure of the last value a pipeline rejected with `REJECTED`, taken
 * by whoever ran it before anything else runs.
 */
let rejection: Failure | undefined;

/** Rejects the value being handled with `failure`. */
function reject(failure: Failure): typeof REJECTED {
	rejection = failure;
	return REJECTED;
}

/** The segments of the JSON pointer of a TypeBox error, numeric ones as numbers. */
function segmentsOf(pointer: string): (string | number)[] {
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => {
			const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
			return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
		});
}

/** A lazy issue of `failure` at `path`. */
function issueOf(
	failure: Failure,
	message: string,
	path: readonly (string | number)[],
	code: IssueCode,
): Issue {
	return new LazyIssue(message, path, code, failure.source, failure);
}

/**
 * Adds to `issues` those of the value a pipeline has just rejected, each
 * under `path`, where the value is. An issue of the value itself has `path`
 * as it is, not a copy.
 * @internal
 */
export function takeRejectionIssues(
	path: readonly (string | number)[],
	issues: Issue[],
): void {
	const failure = rejection as Failure;
	rejection = undefined;
	const { raised, errors, source } = failure;

	if (raised) {
		issues.push({
			message: raised.message,
			path,
			code: "invalid_value",
			source,
			cause: raised,
		});
	} else if (!errors) {
		issues.push(issueOf(failure, "is required", path, "required"));
	} else if (errors.length === 0) {
		issues.push(issueOf(failure, "is invalid", path, "invalid_value"));
	} else {
		for (const { message, instancePath } of errors) {
			issues.push(
				issueOf(
					failure,
					message,
					instancePath === "" ? path : [...path, ...segmentsOf(instancePath)],
					"invalid_value",
				),
			);
		}
	}
}

/** How a property handles its value; `Value` is the value of its schema, as in `ISchema`. */
export abstract class AbstractDefineProperty<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> implements IDefineProperty<SchemaType, Value>
{
	[State]: PropertyStates = PropertyStates.Declared;
	abstract get type(): IPropertyType<SchemaType, Value>;

	/**
	 * The value handled by the property; throws `PropertyRequired` for
	 * `undefined` on a required property, and `InvalidPropertyValue` (or the
	 * exception of a handler) for a value it rejects.
	 */
	make(value: Value): Value {
		const handled = this.attempt(value);
		if (handled !== REJECTED) return handled;

		const failure = rejection as Failure;
		rejection = undefined;
		throw failure.exception();
	}

	/**
	 * Like `make`, but never throws: the handled value, or an issue for each
	 * reason the value is rejected, whose `cause` is the exception `make` would
	 * throw, built when it is read. When the schema is an object or an array,
	 * an issue has the path of the member that failed. An error that is not an
	 * `Exception`, from any step, rejects the value too, as the cause of an
	 * `InvalidPropertyValue`.
	 */
	parse(value: unknown): ParseResult<Value> {
		const handled = this.attemptWithoutThrowing(value);
		if (handled !== REJECTED) return { value: handled };

		const issues: Issue[] = [];
		takeRejectionIssues([], issues);
		return { issues };
	}

	protected preHandle(value: Value): Value {
		return value;
	}

	protected afterHandle(value: Value): Value {
		return value;
	}

	/** The value, or `MISMATCH` when the schema rejects it. */
	protected handle(value: Value): Value {
		return this.type.schema.match(value) ? value : (MISMATCH as never);
	}

	/** `attempt`, with the error of any step as a rejection. */
	private attemptWithoutThrowing(value: unknown): Value | typeof REJECTED {
		try {
			return this.attempt(value as Value);
		} catch (error) {
			return this.raise(
				error instanceof Exception ? error : this.invalidValue(error),
			);
		}
	}

	/**
	 * Runs the pipeline, updating the state: the handled value, or `REJECTED`
	 * with the reason in `rejection`. A handler that is not declared is not
	 * run, and neither is the shape check that protects it.
	 */
	private attempt(value: Value): Value | typeof REJECTED {
		const { name, optional, schema } = this.type;
		this[State] = PropertyStates.Declared;

		if (value === undefined) {
			if (!optional) return reject(new Failure(name, undefined, undefined));
			this[State] = PropertyStates.Done;
			return value;
		}

		const preHandles = this.preHandle !== PASS.preHandle;
		const handles = this.handle !== PASS.handle;

		// preHandle expects the schema's types, so a value of another type is
		// rejected before it reaches it.
		if ((preHandles || handles) && !schema.matchShape(value)) {
			return this.mismatch(value);
		}

		try {
			if (preHandles) {
				this[State] = PropertyStates.PreHandling;
				value = this.runHandler(this.preHandle, value);
			}

			this[State] = PropertyStates.Handling;
			if (handles) {
				const handled = this.handle(value);
				if ((handled as unknown) === MISMATCH) return this.mismatch(value);
				value = handled;
			} else if (!schema.match(value)) {
				// A value of another type stops before any step, as it does when
				// its shape is checked first.
				if (!preHandles && !schema.matchShape(value)) {
					this[State] = PropertyStates.Declared;
				}
				return this.mismatch(value);
			}

			if (this.afterHandle !== PASS.afterHandle) {
				this[State] = PropertyStates.AfterHandling;
				value = this.runHandler(this.afterHandle, value);
			}
		} catch (error) {
			if (error instanceof Exception) return this.raise(error);
			throw error;
		}

		this[State] = PropertyStates.Done;
		return value;
	}

	/**
	 * Runs a handler: an `Exception` it throws goes up as it is, any other
	 * error rejects the value, with the error as its cause.
	 */
	private runHandler(handler: (value: Value) => Value, value: Value): Value {
		try {
			return handler.call(this, value);
		} catch (error) {
			if (error instanceof Exception) throw error;
			throw this.invalidValue(error);
		}
	}

	/** The `InvalidPropertyValue` of an error that is not an `Exception`, as its cause. */
	private invalidValue(error: unknown): Exception {
		return new InvalidPropertyValue({
			source: this.type.name,
			details: {
				errors: [error instanceof Error ? error.message : String(error)],
			},
			cause: error,
		});
	}

	/** Rejects the value with an `exception` that a step threw. */
	private raise(exception: Exception): typeof REJECTED {
		return reject(new Failure(this.type.name, exception, undefined));
	}

	/**
	 * Rejects `value`, which the schema rejects, with its errors, found once
	 * and kept for the details of the exception too.
	 */
	private mismatch(value: unknown): typeof REJECTED {
		const { name, schema } = this.type;
		return reject(new Failure(name, undefined, errorsOfSchema(schema, value)));
	}
}

/** The steps as they are when a property does not declare them. */
const PASS = AbstractDefineProperty.prototype as unknown as {
	preHandle: unknown;
	afterHandle: unknown;
	handle: unknown;
};

/** What the functions below read of a definition, private members included. */
interface Pipeline {
	readonly type: IPropertyType<TSchema, unknown>;
	parse: unknown;
	preHandle(value: unknown): unknown;
	afterHandle(value: unknown): unknown;
	handle: unknown;
	attemptWithoutThrowing(value: unknown): unknown;
	invalidValue(error: unknown): Exception;
	raise(exception: Exception): typeof REJECTED;
	mismatch(value: unknown): typeof REJECTED;
}

/**
 * The prototypes of the definitions `propertyOf` declares: their `type` and
 * their steps are those they were declared with, whatever the value, and no
 * step sees the definition, so nothing can read its state while it runs.
 */
const declared = new WeakSet<object>();

/**
 * Tells that the definitions of `prototype` are as `propertyOf` declares them.
 * @internal
 */
export function declarePipeline(prototype: object): void {
	declared.add(prototype);
}

/**
 * `definition.parse` without its result object: a function giving the handled
 * value, or `REJECTED`, with the issues for `takeRejectionIssues` to take.
 * `undefined` when `definition` has a `parse` of its own, which must be
 * called instead.
 *
 * For a definition declared by `propertyOf`, the function is the pipeline of
 * `attempt` with what never changes read once: which steps there are, the
 * schema, and no state, which nobody can read.
 * @internal
 */
export function parserOf(
	definition: AbstractDefineProperty<TSchema>,
): ((value: unknown) => unknown) | undefined {
	const pipeline = definition as unknown as Pipeline;
	if (pipeline.parse !== AbstractDefineProperty.prototype.parse) {
		return undefined;
	}
	if (
		!declared.has(Object.getPrototypeOf(definition)) ||
		pipeline.handle !== PASS.handle ||
		Object.hasOwn(definition, "preHandle") ||
		Object.hasOwn(definition, "afterHandle")
	) {
		return (value) => pipeline.attemptWithoutThrowing(value);
	}

	const { name, optional, schema } = pipeline.type;
	const preHandle =
		pipeline.preHandle === PASS.preHandle ? undefined : pipeline.preHandle;
	const afterHandle =
		pipeline.afterHandle === PASS.afterHandle
			? undefined
			: pipeline.afterHandle;

	return (value) => {
		if (value === undefined) {
			return optional ? value : reject(new Failure(name, undefined, undefined));
		}
		try {
			if (preHandle !== undefined) {
				if (!schema.matchShape(value)) return pipeline.mismatch(value);
				value = preHandle.call(pipeline, value);
			}
			if (!schema.match(value)) return pipeline.mismatch(value);
			return afterHandle === undefined
				? value
				: afterHandle.call(pipeline, value);
		} catch (error) {
			return pipeline.raise(
				error instanceof Exception ? error : pipeline.invalidValue(error),
			);
		}
	};
}
