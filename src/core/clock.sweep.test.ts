import { expect, test } from "bun:test";
import { Glob } from "bun";

// The time comes from `currentTime()` (src/core/clock.ts), so that
// `configure({ clock })` reaches every site. The logger keeps the real time.
const ALLOWED = new Set(["core/clock.ts", "core/logger/logger.ts"]);

test("nothing under src reads the time but the clock module and the logger", async () => {
	const root = `${import.meta.dir}/..`;
	const offending: string[] = [];
	for await (const path of new Glob("**/*.ts").scan(root)) {
		if (/\.(test|sandbox)\.ts$/.test(path) || ALLOWED.has(path)) continue;
		const source = await Bun.file(`${root}/${path}`).text();
		if (/\bDate\.now\(\)|\bnew Date\(\s*\)/.test(source)) offending.push(path);
	}
	expect(offending).toEqual([]);
});
