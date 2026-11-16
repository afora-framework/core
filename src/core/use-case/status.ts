/** The status and the body of each view {@link withStatus} made. */
const chosen = new WeakMap<
	object,
	{ readonly status: number; readonly body: object }
>();

/**
 * Reads go to the body itself, with the body as the receiver, so that the
 * getters of a record (backed by its own storage) answer as on the body; a
 * method read from the view runs on the body too (`toJSON` included).
 */
const VIEW: ProxyHandler<object> = {
	get: (target, key) => {
		const value = Reflect.get(target, key, target);
		// An inherited method only: an own value of a frozen body must be
		// given as it is.
		return typeof value === "function" &&
			key !== "constructor" &&
			!Object.hasOwn(target, key)
			? (value as (...args: unknown[]) => unknown).bind(target)
			: value;
	},
	has: (target, key) => Reflect.has(target, key),
	ownKeys: (target) => Reflect.ownKeys(target),
	getOwnPropertyDescriptor: (target, key) =>
		Reflect.getOwnPropertyDescriptor(target, key),
};

/**
 * A view of `body`, the body of a response, that carries the HTTP `status`
 * to send it with, for the `execute` of a use case:
 * `return ok ? body : withStatus(503, body)`. The view is a new value for
 * each call, typed as the body and reading as it (fields, getters, keys,
 * `Array.isArray`); the body itself is not changed (a frozen or shared one is
 * fine) and carries no status, so another call that returns it is not
 * affected. The use case takes the status and the body when `execute` returns. The use case validates the body
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
	if (typeof body !== "object" || body === null) return body;
	const view = new Proxy<Body>(body, VIEW as ProxyHandler<Body>);
	chosen.set(view, { status, body });
	return view;
}

/**
 * The status {@link withStatus} gave `value`, or `undefined`. A sink that
 * serves HTTP reads it on what `operation.invoke` resolves with; a transform
 * that wraps `invoke` must resolve with that same value for it to survive.
 */
export function chosenStatusOf(value: unknown): number | undefined {
	return typeof value === "object" && value !== null
		? chosen.get(value)?.status
		: undefined;
}

/**
 * The status {@link withStatus} gave `value` and the body it was given, or
 * no status and `value` itself.
 */
export function takeStatus(value: unknown): {
	readonly status: number | undefined;
	readonly body: unknown;
} {
	const mark =
		typeof value === "object" && value !== null ? chosen.get(value) : undefined;
	return mark ?? { status: undefined, body: value };
}
