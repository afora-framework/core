import { expect, test } from "bun:test";
import { generate, writeGenerated } from "@afora/codegen";
import { stages } from "@afora/hono";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const dir = new URL("./from-json/", import.meta.url).pathname;

test("from afora.json: the README shows the files of from-json", async () => {
	const readme = await read("../../README.md");

	for (const file of ["stages.ts", "src/hash-password.ts", "src/server.ts"]) {
		expect(readme).toContain((await read(`./from-json/${file}`)).trim());
	}
});

test("from afora.json: the generated app serves the quick start", async () => {
	const spec = JSON.parse(await read("./quickstart.afora.json"));
	const result = await writeGenerated(dir, generate(spec, [], { stages }));
	expect(result.refused).toEqual([]);

	const { api } = await import("./from-json/src/server.ts");
	const body = {
		name: "Ana",
		email: "ana@example.com",
		plainPassword: "Str0ng!Pass",
	};
	const register = () =>
		api.request("/api/users", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	const created = await register();
	const { user } = (await created.json()) as { user: Record<string, unknown> };
	expect(created.status).toBe(201);
	expect(user.password).toBe("********");

	const again = await register();
	expect(again.status).toBe(409);
	expect(again.headers.get("content-type")).toContain(
		"application/problem+json",
	);
});
