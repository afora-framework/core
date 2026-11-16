// A fast format check must accept exactly what TypeBox accepts: it may only
// answer `true` for a value TypeBox accepts, and the match of a schema built
// on it must agree with the compiled TypeBox check on every value.
import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import Compile from "typebox/compile";
import { Format } from "typebox/format";
import { fastFormatOf, isPlainDate, isUtcDateTime } from "./formats";
import { checksOfSchema, schemaOf } from "./schema";

afterEach(() => {
	Format.Set("date-time", Format.IsDateTime);
});

/** Mulberry32, so a failure can be replayed by its seed. */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (value: number, width: number) =>
	String(value).padStart(width, "0");

/** A date and time near the valid ones: each part sometimes out of range or malformed. */
function dateTime(random: () => number): string {
	const pick = <Value>(values: readonly Value[]) =>
		values[Math.floor(random() * values.length)] as Value;
	const year = pick([2024, 2023, 1900, 2000, 0, 9999, 2100]);
	const month = Math.floor(random() * 14);
	const day = Math.floor(random() * 33);
	const hour = Math.floor(random() * 26);
	const minute = Math.floor(random() * 62);
	const second = Math.floor(random() * 62);
	const fraction = pick(["", ".1", ".123", ".123456789", ".", ".x"]);
	const zone = pick(["Z", "Z", "Z", "z", "+00:00", "-03:00", "+24:00", ""]);
	const separator = pick(["T", "T", "T", "t", " "]);
	const suffix = pick(["", "", "", "[UTC]", "[!x"]);
	let text = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}${separator}${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${fraction}${zone}${suffix}`;
	// Now and then, one character replaced or the text cut.
	if (random() < 0.1) {
		const at = Math.floor(random() * text.length);
		text =
			text.slice(0, at) + pick(["a", "-", "0", ":", "Z"]) + text.slice(at + 1);
	}
	if (random() < 0.05) text = text.slice(0, Math.floor(random() * text.length));
	return text;
}

const typeboxDateTime = Compile(Type.String({ format: "date-time" }));
const typeboxDate = Compile(Type.String({ format: "date" }));

test("a fast check only accepts what TypeBox accepts, and every toISOString", () => {
	const random = generator(7);
	let fast = 0;
	for (let index = 0; index < 50_000; index++) {
		const text = dateTime(random);
		if (isUtcDateTime(text)) {
			fast++;
			expect({ text, typebox: typeboxDateTime.Check(text) }).toEqual({
				text,
				typebox: true,
			});
		}
		const date = text.slice(0, 10);
		if (isPlainDate(date)) {
			expect({ date, typebox: typeboxDate.Check(date) }).toEqual({
				date,
				typebox: true,
			});
		}
	}
	// The generator reaches the fast path often, not only the slow one.
	expect(fast).toBeGreaterThan(2_000);

	for (let index = 0; index < 5_000; index++) {
		const iso = new Date(random() * 4e12 - 1e12).toISOString();
		if (iso.startsWith("-") || iso.startsWith("+")) continue;
		expect(isUtcDateTime(iso)).toBe(true);
		expect(isPlainDate(iso.slice(0, 10))).toBe(true);
	}
});

test("the match of a date-time or date schema agrees with TypeBox on every value", () => {
	const DateTime = schemaOf("dt", Type.String({ format: "date-time" }));
	const DateOnly = schemaOf("d", Type.String({ format: "date" }));
	const dateTimeChecks = checksOfSchema(new DateTime());
	const dateChecks = checksOfSchema(new DateOnly());
	const random = generator(11);
	for (let index = 0; index < 20_000; index++) {
		const text = dateTime(random);
		expect([text, dateTimeChecks.match(text)]).toEqual([
			text,
			typeboxDateTime.Check(text),
		]);
		const date = text.slice(0, 10);
		expect([date, dateChecks.match(date)]).toEqual([
			date,
			typeboxDate.Check(date),
		]);
	}
	for (const value of [undefined, null, 1, {}, [], new Date()]) {
		expect(dateTimeChecks.match(value)).toBe(false);
		expect(dateChecks.match(value)).toBe(false);
	}
});

test("leap years, the last day of each month and leap seconds", () => {
	expect(isPlainDate("2024-02-29")).toBe(true);
	expect(isPlainDate("2023-02-29")).toBe(false);
	expect(isPlainDate("1900-02-29")).toBe(false);
	expect(isPlainDate("2000-02-29")).toBe(true);
	expect(isPlainDate("2026-04-31")).toBe(false);
	// A leap second is TypeBox's to judge: the fast check leaves it.
	expect(isUtcDateTime("2016-12-31T23:59:60Z")).toBe(false);
	expect(typeboxDateTime.Check("2016-12-31T23:59:60Z")).toBe(true);
});

test("only a plain string of the format gets a fast check", () => {
	expect(fastFormatOf(Type.String({ format: "date-time" }))).toBe(
		isUtcDateTime,
	);
	expect(fastFormatOf(Type.String({ format: "date", title: "Day" }))).toBe(
		isPlainDate,
	);
	expect(
		fastFormatOf(Type.String({ format: "date-time", maxLength: 20 })),
	).toBeUndefined();
	expect(fastFormatOf(Type.String({ format: "email" }))).toBeUndefined();
	expect(fastFormatOf(Type.String())).toBeUndefined();
});

test("a format an application replaced is not checked fast", () => {
	const strict = (value: string) => value.endsWith("+00:00");
	Format.Set("date-time", strict);
	expect(fastFormatOf(Type.String({ format: "date-time" }))).toBeUndefined();
	const Replaced = schemaOf("replaced", Type.String({ format: "date-time" }));
	expect(checksOfSchema(new Replaced()).match("2026-01-01T00:00:00Z")).toBe(
		false,
	);
});
