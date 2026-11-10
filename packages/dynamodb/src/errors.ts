/**
 * What a failed write of DynamoDB means for the provider, read from the error
 * by name (not `instanceof`, which two copies of the SDK would break):
 *
 * - `condition`: the condition of item `index` failed (a single `Put`,
 *   `Update` or `Delete` is item 0);
 * - `conflict`: another transaction held an item, worth retrying;
 * - `undefined`: anything else, rethrown as it is.
 */
export type WriteFailure =
	| { readonly kind: "condition"; readonly index: number }
	| { readonly kind: "conflict" };

interface CancellationReason {
	readonly Code?: string;
}

export function writeFailureOf(error: unknown): WriteFailure | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const { name, CancellationReasons } = error as {
		readonly name?: unknown;
		readonly CancellationReasons?: readonly CancellationReason[];
	};
	if (name === "ConditionalCheckFailedException")
		return { kind: "condition", index: 0 };
	if (name === "TransactionConflictException") return { kind: "conflict" };
	if (name !== "TransactionCanceledException") return undefined;
	const reasons = CancellationReasons ?? [];
	const index = reasons.findIndex(
		(reason) => reason.Code === "ConditionalCheckFailed",
	);
	if (index >= 0) return { kind: "condition", index };
	if (reasons.some((reason) => reason.Code === "TransactionConflict"))
		return { kind: "conflict" };
	return undefined;
}

/** The delay before attempt `attempt` (1 for the first retry): exponential, capped, with full jitter. */
export function backoffOf(
	attempt: number,
	baseMs: number,
	random: () => number = Math.random,
): number {
	const ceiling = Math.min(baseMs * 2 ** (attempt - 1), 2_000);
	return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}
