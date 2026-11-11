import { backoffOf } from "./errors";

/** A key of the table. */
export type ItemKey = { readonly pk: string; readonly sk: string };

/** What `BatchGetItem` answers, as the document client gives it. */
export interface BatchGetPage {
	readonly Responses?: Readonly<Record<string, Record<string, unknown>[]>>;
	readonly UnprocessedKeys?: Readonly<
		Record<string, { readonly Keys?: Record<string, unknown>[] }>
	>;
}

export interface BatchGetOptions {
	readonly table: string;
	/** Sends one `BatchGetItem` of at most 100 keys of `table`. */
	readonly send: (keys: readonly ItemKey[]) => Promise<BatchGetPage>;
	/** The attempts of each chunk, the first included. */
	readonly attempts: number;
	readonly baseDelayMs: number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Called before each retry, with the keys left. */
	readonly onRetry?: (attempt: number, left: number) => void;
	/** Called when the attempts run out; must throw. */
	readonly onExhausted: (attempts: number) => never;
}

/** The most keys one `BatchGetItem` takes. */
const BATCH_GET_LIMIT = 100;

const wait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every item of `keys` that exists, in chunks of 100, asking again for the
 * keys DynamoDB leaves unprocessed (throttling, the 16 MB limit) with an
 * exponential backoff, up to `attempts` times per chunk.
 */
export async function batchGetAll(
	keys: readonly ItemKey[],
	options: BatchGetOptions,
): Promise<Record<string, unknown>[]> {
	const { table, send, attempts, baseDelayMs, sleep = wait } = options;
	const found: Record<string, unknown>[] = [];
	for (let start = 0; start < keys.length; start += BATCH_GET_LIMIT) {
		let pending: readonly ItemKey[] = keys.slice(
			start,
			start + BATCH_GET_LIMIT,
		);
		for (let attempt = 1; pending.length > 0; attempt++) {
			if (attempt > attempts) options.onExhausted(attempts);
			if (attempt > 1) {
				options.onRetry?.(attempt, pending.length);
				await sleep(backoffOf(attempt - 1, baseDelayMs));
			}
			const page = await send(pending);
			found.push(...(page.Responses?.[table] ?? []));
			pending = (page.UnprocessedKeys?.[table]?.Keys ?? []) as ItemKey[];
		}
	}
	return found;
}
