/** A share of runs and its 95% Wilson score interval. */
export interface Rate {
	readonly passed: number;
	readonly runs: number;
	/** The bounds of the interval, between 0 and 1. */
	readonly low: number;
	readonly high: number;
}

/** z for a two-sided 95% interval. */
const Z = 1.959964;

/**
 * The Wilson score interval of `passed` successes in `runs` trials: unlike
 * the normal approximation it stays within [0, 1] and is not empty at 0/n or
 * n/n, which is where a small sample of runs usually lands.
 */
export function wilson(passed: number, runs: number): Rate {
	if (!Number.isInteger(passed) || !Number.isInteger(runs) || runs < 0) {
		throw new Error("wilson takes whole counts.");
	}
	if (passed < 0 || passed > runs) {
		throw new Error("passed must be between 0 and runs.");
	}
	if (runs === 0) return { passed, runs, low: 0, high: 1 };
	const p = passed / runs;
	const z2 = Z * Z;
	const denominator = 1 + z2 / runs;
	const center = (p + z2 / (2 * runs)) / denominator;
	const half =
		(Z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) /
		denominator;
	return {
		passed,
		runs,
		low: Math.max(0, center - half),
		high: Math.min(1, center + half),
	};
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** `18/20 (90%; 95% CI 70–97%)`, or `not in brief` when no run was checked. */
export function formatRate(rate: Rate): string {
	if (rate.runs === 0) return "not in brief";
	return `${rate.passed}/${rate.runs} (${percent(rate.passed / rate.runs)}; ${percent(rate.low)}–${percent(rate.high)})`;
}
