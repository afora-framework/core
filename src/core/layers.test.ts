import { expect, test } from "bun:test";
import { Glob } from "bun";

test("the core does not import the standard properties", async () => {
	const offending: string[] = [];
	for await (const path of new Glob("**/*.ts").scan(import.meta.dir)) {
		if (/\.(test|sandbox)\.ts$/.test(path)) continue;
		const source = await Bun.file(`${import.meta.dir}/${path}`).text();
		if (/from "[./]*\/std\//.test(source)) offending.push(path);
	}
	expect(offending).toEqual([]);
});
