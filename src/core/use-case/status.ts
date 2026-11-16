import { Kind } from "../symbols/kind";

declare const statusBrand: unique symbol;

/**
 * What {@link withStatus} gives: the body of a response with the status to
 * send it with. Typed as the body itself (plus a brand that exists only in
 * types), so that `execute` keeps the response type for its callers; at run
 * time it is a wrapper that only the use case reads, so return it, never
 * read from it.
 */
export type WithStatus<Body> = Body & { readonly [statusBrand]: number };

/** What `withStatus` holds at run time. */
interface StatusEnvelope {
	readonly [Kind]: "status";
	readonly status: number;
	readonly body: unknown;
}

/**
 * The body of a response with the HTTP `status` to send it with, for the
 * `execute` of a use case: `return ok ? body : withStatus(503, body)`. The
 * use case validates the body against its `response` as usual. The route of
 * the use case declares each status other than its default one in
 * `route.statuses` (`{ method: "get", path: "/health", statuses: [503] }`):
 * an HTTP sink answers an undeclared one with `UndeclaredStatus`, a masked
 * 500. Every status sends the body as a success, 5xx included (not a
 * problem). A direct call (`execute()`), a use case called as a dependency
 * and the sinks that do not speak HTTP (`mcp`, `ws`) get the body only.
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
export function withStatus<Body>(status: number, body: Body): WithStatus<Body> {
	return Object.freeze({
		[Kind]: "status",
		status,
		body,
	} satisfies StatusEnvelope) as unknown as WithStatus<Body>;
}

/** Whether `value` was made by {@link withStatus}. */
export function isWithStatus(value: unknown): value is StatusEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "status"
	);
}

/**
 * The status and the body of `value`: those {@link withStatus} gave it, or
 * no status and `value` itself.
 */
export function unwrapStatus(value: unknown): {
	readonly status: number | undefined;
	readonly body: unknown;
} {
	return isWithStatus(value)
		? { status: value.status, body: value.body }
		: { status: undefined, body: value };
}
