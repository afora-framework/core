import { afterEach, expect, test } from "bun:test";
import { currentTime, setClock } from "./clock";

afterEach(() => setClock(undefined));

test("reads the platform clock by default", () => {
	const before = Date.now();
	const read = currentTime();
	expect(read).toBeGreaterThanOrEqual(before);
	expect(read).toBeLessThanOrEqual(Date.now());
});

test("reads the clock set, and the platform again once it is cleared", () => {
	setClock(() => 42);
	expect(currentTime()).toBe(42);
	setClock(undefined);
	expect(currentTime()).toBeGreaterThan(42);
});
