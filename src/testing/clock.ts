import type { Clock } from "../core/clock";

const UNITS = {
	milliseconds: 1,
	seconds: 1000,
	minutes: 60_000,
	hours: 3_600_000,
	days: 86_400_000,
	weeks: 604_800_000,
} as const;

/** A span of time given by parts, as `advance` takes it. */
export type ClockSpan = { readonly [Unit in keyof typeof UNITS]?: number };

/** A `Clock` that stands still until it is moved. */
export interface ManualClock extends Clock {
	/** The current time of the clock, in epoch milliseconds. */
	now(): number;
	/** Moves the clock to a date, epoch milliseconds or ISO string. */
	set(at: Date | number | string): void;
	/** Moves the clock forward (or back, if negative) by milliseconds or by parts. */
	advance(by: number | ClockSpan): void;
}

function millisecondsOf(at: Date | number | string): number {
	const ms = typeof at === "number" ? at : new Date(at).getTime();
	if (!Number.isFinite(ms)) {
		throw new TypeError(`manualClock: ${String(at)} is not a valid time.`);
	}
	return ms;
}

/**
 * A clock for the `runtime` of an application, `withRuntime` or
 * `configure({ clock })` that only moves when told: `set` jumps
 * to a time, `advance` moves by milliseconds or by `{ minutes, days… }`.
 * It starts at `start` (2026-01-01T00:00:00.000Z by default).
 */
export function manualClock(
	start: Date | number | string = "2026-01-01T00:00:00.000Z",
): ManualClock {
	let current = millisecondsOf(start);
	const clock = (() => current) as ManualClock;
	clock.now = () => current;
	clock.set = (at) => {
		current = millisecondsOf(at);
	};
	clock.advance = (by) => {
		let ms = 0;
		if (typeof by === "number") ms = by;
		else {
			for (const unit of Object.keys(UNITS) as (keyof typeof UNITS)[]) {
				ms += (by[unit] ?? 0) * UNITS[unit];
			}
		}
		if (!Number.isFinite(ms)) {
			throw new TypeError("manualClock: advance needs a finite span.");
		}
		current += ms;
	};
	return clock;
}
