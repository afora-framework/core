/** Result of a language request that was superseded or aborted before running. */
export const stale = Symbol("stale");

type Task = {
	version: number | undefined;
	interactive: boolean;
	signal: AbortSignal | undefined;
	run: () => unknown;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};

const yieldToEventLoop = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Per-session queue for the synchronous language service. Tasks run one at a
 * time after yielding to the event loop, so requests that arrive meanwhile can
 * supersede them: a task whose buffer version is older than the latest seen,
 * or whose request was aborted, resolves to `stale` without running.
 * Interactive tasks (completions, hover…) run before pending diagnostics.
 * Tasks without a version are never considered stale.
 */
export function languageQueue() {
	let latest = Number.NEGATIVE_INFINITY;
	const pending: Task[] = [];
	let draining = false;
	async function drain() {
		draining = true;
		try {
			while (pending.length) {
				await yieldToEventLoop();
				const index = pending.findIndex((task) => task.interactive);
				const [task] = pending.splice(Math.max(index, 0), 1);
				if (!task) continue;
				if (
					task.signal?.aborted ||
					(task.version !== undefined && task.version < latest)
				) {
					task.resolve(stale);
					continue;
				}
				try {
					task.resolve(task.run());
				} catch (error) {
					task.reject(error);
				}
			}
		} finally {
			draining = false;
		}
	}
	return {
		run<T>(
			run: () => T,
			options: {
				version?: number;
				interactive?: boolean;
				signal?: AbortSignal;
			} = {},
		): Promise<T | typeof stale> {
			const { version, interactive = false, signal } = options;
			if (version !== undefined && version > latest) latest = version;
			return new Promise((resolve, reject) => {
				pending.push({
					version,
					interactive,
					signal,
					run,
					resolve: resolve as (value: unknown) => void,
					reject,
				});
				if (!draining) void drain();
			});
		},
	};
}
