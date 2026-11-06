import type { ExceptionLayers } from "./enums/exception-layers";
import type {
	ExceptionArgs,
	ExceptionClass,
	ExceptionDeclaration,
	ExceptionFrame,
	ExceptionInit,
	ExceptionPropagation,
	ExceptionScope,
} from "./types/exception.interface";

/** Name given to an error that is not an `Exception` when it gets wrapped. */
export const UNEXPECTED_ERROR = "UnexpectedError";

/**
 * An error that knows the layer it was raised in and who raised it. Passing it
 * to an upper layer (`propagate`, or a new exception with it as `cause`) keeps
 * every step in `trace`.
 */
export class Exception<Details = unknown> extends Error {
	override readonly name: string;
	readonly layer: ExceptionLayers;
	readonly source: string;
	readonly details: Details;
	override readonly cause?: unknown;

	constructor({
		layer,
		name,
		source,
		message,
		details,
		cause,
	}: ExceptionInit<Details>) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = name;
		this.layer = layer;
		this.source = source;
		this.details = details as Details;
		this.cause = cause;
	}

	/** `error` as an exception; anything else is wrapped as raised in `scope`. */
	static from(error: unknown, scope: ExceptionScope): Exception {
		if (error instanceof Exception) return error;

		return new Exception({
			...scope,
			name: UNEXPECTED_ERROR,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		});
	}

	/** This step of the trace. */
	get frame(): ExceptionFrame<Details> {
		const { layer, name, source, message, details } = this;
		return { layer, name, source, message, details };
	}

	/** Every step, from where it was first raised to this one. */
	get trace(): readonly ExceptionFrame[] {
		return this.chain()
			.map((exception) => exception.frame)
			.reverse();
	}

	/** The exception that was first raised. */
	get origin(): Exception {
		return this.chain().at(-1) as Exception;
	}

	/** The first exception of the trace, from this one down, that is `target`. */
	find<Instance extends Exception>(
		target: ExceptionClass<Instance> | string,
	): Instance | undefined {
		return this.chain().find((exception) =>
			typeof target === "string"
				? exception.name === target
				: exception instanceof target,
		) as Instance | undefined;
	}

	/** Whether `target` is this exception or one of its causes. */
	is(target: ExceptionClass | string): boolean {
		return this.find(target) !== undefined;
	}

	/** Whether the exception was raised or passed through `layer`. */
	passedThrough(layer: ExceptionLayers): boolean {
		return this.chain().some((exception) => exception.layer === layer);
	}

	/**
	 * Passes the exception to an upper layer: a new exception in `scope`, with
	 * this one as its cause, keeping its name and message unless given others.
	 */
	propagate<Next = undefined>({
		layer,
		source,
		name = this.name,
		message = this.message,
		details,
	}: ExceptionPropagation<Next>): Exception<Next> {
		return new Exception({
			layer,
			source,
			name,
			message,
			details,
			cause: this,
		});
	}

	toJSON(): ExceptionFrame<Details> & { trace: readonly ExceptionFrame[] } {
		return { ...this.frame, trace: this.trace };
	}

	override toString(): string {
		return this.chain()
			.map(
				(exception, index) =>
					`${index === 0 ? "" : "  <- "}${exception.name} [${exception.layer} @ ${exception.source}]: ${exception.message}`,
			)
			.join("\n");
	}

	/** This exception followed by its causes that are exceptions. */
	private chain(): Exception[] {
		const chain: Exception[] = [];
		for (
			let current: unknown = this;
			current instanceof Exception;
			current = current.cause
		) {
			chain.push(current);
		}
		return chain;
	}
}

/** A class declared with `exceptionOf`. */
export interface DeclaredExceptionClass<Details = undefined> {
	new (args: ExceptionArgs<Details>): Exception<Details>;
	readonly prototype: Exception<Details>;
	readonly layer: ExceptionLayers;
	from: typeof Exception.from;
}

const declarations = new WeakMap<object, { readonly message: unknown }>();

/** Whether `value` is a class made by `exceptionOf`. */
export function isDeclaredException(
	value: unknown,
): value is DeclaredExceptionClass<never> {
	return typeof value === "function" && declarations.has(value);
}

/** The message `exceptionOf` got, when it was a string; `undefined` otherwise. */
export function declaredMessageOf(
	Declared: DeclaredExceptionClass<never>,
): string | undefined {
	const { message } = declarations.get(Declared) ?? {};
	return typeof message === "string" ? message : undefined;
}

/**
 * Declares an exception of `layer`, e.g.
 * `throw new PropertyRequired({ source: "email" })`. Its `details` are typed
 * by the parameter of `message`, when it is a function.
 */
export function exceptionOf<Details = undefined>({
	layer,
	name,
	message,
}: ExceptionDeclaration<Details>): DeclaredExceptionClass<Details> {
	class DeclaredException extends Exception<Details> {
		static readonly layer = layer;

		constructor({
			source,
			details,
			cause,
			message: custom,
		}: ExceptionArgs<Details>) {
			super({
				layer,
				name,
				source,
				details,
				cause,
				message:
					custom ??
					(typeof message === "function"
						? message(details as Details, source)
						: message),
			});
		}
	}

	Object.defineProperty(DeclaredException, "name", { value: name });
	declarations.set(DeclaredException, { message });

	return DeclaredException;
}
