import { describe, expect, test } from "bun:test";
import { generate } from "../src";

const spec = (dir: string) => ({
	version: 1,
	output: { dir },
	blueprints: { A: { fields: { n: "text" } } },
});

describe("output.dir", () => {
	test("its leading `./` and trailing `/` are left out of the generated paths", () => {
		const paths = generate(spec("./src/x///") as never).map(
			(file) => file.path,
		);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) expect(path).toMatch(/^src\/x\/[^/]+$/);
	});

	test("a long run of `/` not at the end is handled in linear time (code scanning: polynomial ReDoS)", () => {
		const start = performance.now();
		try {
			generate(spec(`a${"/".repeat(100_000)}a`) as never);
		} catch {
			// refused or not, it must answer quickly
		}
		expect(performance.now() - start).toBeLessThan(200);
	});
});
