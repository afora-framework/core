/** The status each body was given by {@link withStatus}, until it is read. */
const chosen = new WeakMap<object, number>();

/**
 * `body`, the body of a response, itself, marked with the HTTP `status` to
 * send it with, for the `execute` of a use case:
 * `return ok ? body : withStatus(503, body)`. The body is not changed or
 * copied (a frozen one is fine): the status is kept beside it, and the use
 * case takes it when `execute` returns. The use case validates the body
 * against its `response` as usual. The route of the use case declares each
 * status other than its default one in `route.statuses`
 * (`{ method: "get", path: "/health", statuses: [503] }`): an HTTP sink
 * answers an undeclared one with `UndeclaredStatus`, a masked 500. Every
 * status sends the body as a success, 5xx included (not a problem). A direct
 * call (`execute()`), a use case called as a dependency and the sinks that
 * do not speak HTTP (`mcp`, `ws`) get the body only.
 *
 * @example
 * ```ts
 * import { blueprintOf, useCaseOf, withStatus } from "@afora/core";
 *
 * declare function ping(): Promise<boolean>;
 *
 * class Health extends useCaseOf({
 * 	name: "Health",
 * 	blueprint: blueprintOf(() => ({})),
 * 	response: blueprintOf((ctx) => ({ ok: ctx.boolean })),
 * 	route: { method: "get", path: "/health", statuses: [503] },
 * }) {
 * 	override async execute() {
 * 		const ok = await ping();
 * 		return ok ? { ok } : withStatus(503, { ok });
 * 	}
 * }
 * ```
 */
export function withStatus<Body extends object>(
	status: number,
	body: Body,
): Body {
	chosen.set(body, status);
	return body;
}

/**
 * The status {@link withStatus} gave `value`, or `undefined`. A sink that
 * serves HTTP reads it on what `operation.invoke` resolves with.
 */
export function chosenStatusOf(value: unknown): number | undefined {
	return typeof value === "object" && value !== null
		? chosen.get(value)
		: undefined;
}

/**
 * The status {@link withStatus} gave `value`, or `undefined`, and forgets
 * it: the same object returned again later has no status of its own.
 */
export function takeStatus(value: unknown): number | undefined {
	const status = chosenStatusOf(value);
	if (status !== undefined) chosen.delete(value as object);
	return status;
}
