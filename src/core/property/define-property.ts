import type { Static, TSchema } from "typebox";
import { Exception } from "../exception/exception";
import { withLazyCause } from "../parse/issue";
import type { Issue, ParseResult } from "../parse/types/parse.interface";
import { describeError } from "../schema/schema";
import { State } from "../symbols/state";
import { PropertyStates } from "./enums/property-states";
import { InvalidPropertyValue, PropertyRequired } from "./exceptions";
import type { IDefineProperty } from "./types/define-property.interface";
import type { IPropertyType } from "./types/property-type.interface";

/** What `handle` gives back for a value the schema rejects. */
const MISMATCH = Symbol("mismatch");

/** Why a value stopped the pipeline: the exception `make` throws, and the issues `parse` returns. */
interface Failure {
	/** The exception, built the first time it is asked for. */
	readonly exception: () => Exception;
	/** Whether a step threw `exception`, so it is the `cause` of the issues as it is. */
	readonly raised: boolean;
	readonly issues: readonly Issue[];
}

/** `build`, run once; the same result after. */
function once<Result>(build: () => Result): () => Result {
	let result: Result | undefined;
	return () => {
		result ??= build();
		return result;
	};
}

/** The segments of the JSON pointer of a TypeBox error, numeric ones as numbers. */
function segmentsOf(pointer: string): (string | number)[] {
	if (pointer === "") return [];
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => {
			const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
			return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
		});
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
		const attempt = this.attempt(value);
		if ("failure" in attempt) throw attempt.failure.exception();
		return attempt.value;
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
		const attempt = this.attemptWithoutThrowing(value);
		if (!("failure" in attempt)) return { value: attempt.value };

		const { exception, raised, issues } = attempt.failure;
		return {
			issues: issues.map((issue) =>
				raised
					? { ...issue, cause: exception() }
					: withLazyCause(issue, exception),
			),
		};
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

	/** `attempt`, with the error of any step as a failure. */
	private attemptWithoutThrowing(
		value: unknown,
	): { readonly value: Value } | { readonly failure: Failure } {
		try {
			return this.attempt(value as Value);
		} catch (error) {
			return {
				failure: this.raise(
					error instanceof Exception ? error : this.invalidValue(error),
				),
			};
		}
	}

	/** Runs the pipeline, updating the state, and tells why it stopped if it did. */
	private attempt(
		value: Value,
	): { readonly value: Value } | { readonly failure: Failure } {
		const { name, optional } = this.type;
		this[State] = PropertyStates.Declared;

		if (value === undefined) {
			if (!optional) {
				return {
					failure: {
						exception: () => new PropertyRequired({ source: name }),
						raised: false,
						issues: [
							{
								message: "is required",
								path: [],
								code: "required",
								source: name,
							},
						],
					},
				};
			}
			this[State] = PropertyStates.Done;
			return { value };
		}

		// preHandle expects the schema's types, so a value of another type is
		// rejected before it reaches it.
		if (!this.type.schema.matchShape(value)) {
			return { failure: this.mismatch(value) };
		}

		try {
			this[State] = PropertyStates.PreHandling;
			value = this.runHandler(() => this.preHandle(value));

			this[State] = PropertyStates.Handling;
			const handled = this.handle(value);
			if ((handled as unknown) === MISMATCH) {
				return { failure: this.mismatch(value) };
			}
			value = handled;

			this[State] = PropertyStates.AfterHandling;
			value = this.runHandler(() => this.afterHandle(value));
		} catch (error) {
			if (error instanceof Exception) return { failure: this.raise(error) };
			throw error;
		}

		this[State] = PropertyStates.Done;
		return { value };
	}

	/**
	 * Runs a handler: an `Exception` it throws goes up as it is, any other
	 * error rejects the value, with the error as its cause.
	 */
	private runHandler(handler: () => Value): Value {
		try {
			return handler();
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

	/** The failure of an `exception` that a step threw. */
	private raise(exception: Exception): Failure {
		return {
			exception: () => exception,
			raised: true,
			issues: [
				{
					message: exception.message,
					path: [],
					code: "invalid_value",
					source: this.type.name,
				},
			],
		};
	}

	/**
	 * The failure of `value`, which the schema rejects: an issue for each of its
	 * errors, found once and kept for the details of the exception too.
	 */
	private mismatch(value: unknown): Failure {
		const { name, schema } = this.type;
		const errors = schema.type.Errors(value);
		const issues: Issue[] = errors.map((error) => ({
			message: error.message,
			path: segmentsOf(error.instancePath),
			code: "invalid_value",
			source: name,
		}));

		return {
			exception: once(
				() =>
					new InvalidPropertyValue({
						source: name,
						details: { errors: errors.map(describeError) },
					}),
			),
			raised: false,
			issues:
				issues.length > 0
					? issues
					: [
							{
								message: "is invalid",
								path: [],
								code: "invalid_value",
								source: name,
							},
						],
		};
	}
}
