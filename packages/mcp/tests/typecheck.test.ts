import { describe, expect, test } from "bun:test";
import { parseDiagnostics } from "../src/typecheck";

describe("parseDiagnostics", () => {
	test("reads the path, position, code and message, and continuation lines", () => {
		expect(
			parseDiagnostics(
				"src/a (1).ts(3,5): error TS2322: Type 'x' is not (1,2): error TS9: y\n    more\nnoise",
			),
		).toEqual([
			{
				path: "src/a (1).ts",
				file: "src/a (1).ts",
				line: 3,
				column: 5,
				code: "TS2322",
				message: "Type 'x' is not (1,2): error TS9: y\nmore",
			},
		]);
	});

	test("a line with no path before the position is not a diagnostic", () => {
		expect(parseDiagnostics("(3,5): error TS2322: no path")).toEqual([]);
	});

	test("a line repeating the pattern is parsed in linear time (code scanning: polynomial ReDoS)", () => {
		const line = `a(0,0): error TS0: ${"a(0,0): error TS0: a".repeat(100_000)}`;
		const start = performance.now();
		expect(parseDiagnostics(`${line}\r`)).toHaveLength(1);
		expect(performance.now() - start).toBeLessThan(200);
	});
});
