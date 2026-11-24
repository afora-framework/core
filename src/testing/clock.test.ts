import { expect, test } from "bun:test";
import { manualClock } from "./clock";

test("starts where it is told and stands still", () => {
	const clock = manualClock("2026-01-01T00:00:00.000Z");
	expect(clock()).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
	expect(clock.now()).toBe(clock());
});

test("set takes a date, milliseconds or an ISO string", () => {
	const clock = manualClock();
	clock.set(new Date("2027-01-01T00:00:00.000Z"));
	expect(clock.now()).toBe(Date.parse("2027-01-01T00:00:00.000Z"));
	clock.set(5);
	expect(clock.now()).toBe(5);
	clock.set("2028-01-01");
	expect(clock.now()).toBe(Date.parse("2028-01-01"));
});

test("advance takes milliseconds or parts, forward or back", () => {
	const clock = manualClock(0);
	clock.advance(1500);
	expect(clock.now()).toBe(1500);
	clock.advance({ days: 1, minutes: 2, seconds: 3 });
	expect(clock.now()).toBe(1500 + 86_400_000 + 120_000 + 3000);
	clock.advance(-clock.now());
	expect(clock.now()).toBe(0);
});

test("refuses a time it cannot read", () => {
	expect(() => manualClock("nope")).toThrow(TypeError);
	expect(() => manualClock(0).advance(Number.NaN)).toThrow(TypeError);
});
