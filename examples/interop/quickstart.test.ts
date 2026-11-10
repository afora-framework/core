import { expect, test } from "bun:test";
import { generate, validateSpec } from "@afora/codegen";
import { stages } from "@afora/hono";
import { api } from "./quickstart.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const ana = {
	name: "Ana",
	email: "  Ana@Example.COM ",
	plainPassword: "Str0ng!Pass",
};

const post = (value: unknown) =>
	api.request("/api/accounts/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});

test("quickstart: the README shows the code of quickstart.ts", async () => {
	const source = await read("./quickstart.ts");
	const readme = await read("../../README.md");

	expect(readme).toContain(source.trim());
});

test("quickstart: the README shows the afora.json of quickstart.afora.json", async () => {
	const spec = await read("./quickstart.afora.json");
	const readme = await read("../../README.md");

	expect(readme).toContain(spec.trim());
});

test("quickstart: a body becomes a saved user, password masked", async () => {
	const response = await post(ana);
	const { user } = (await response.json()) as { user: Record<string, unknown> };

	expect(response.status).toBe(200);
	expect(user.name).toBe("Ana");
	expect(user.email).toBe("ana@example.com");
	expect(user.password).toBe("********");
	expect(typeof user.id).toBe("string");
});

test("quickstart: the same email again is a 409 problem", async () => {
	const response = await post({ ...ana, name: "Other" });
	const problem = (await response.json()) as { title: string; layer: string };

	expect(response.status).toBe(409);
	expect(response.headers.get("content-type")).toContain(
		"application/problem+json",
	);
	expect(problem.title).toBe("UserAlreadyExists");
	expect(problem.layer).toBe("use-case");
});

test("quickstart: an invalid body is a 400 with issue paths", async () => {
	const response = await post({ name: "Ana", email: "nope" });
	const problem = (await response.json()) as {
		issues: { path: unknown[] }[];
	};

	expect(response.status).toBe(400);
	expect(problem.issues.map((issue) => issue.path)).toEqual([
		["email"],
		["plainPassword"],
	]);
});

test("quickstart: the OpenAPI document lists the operation", async () => {
	const response = await api.request("/openapi.json");
	const document = (await response.json()) as { paths: object };

	expect(response.status).toBe(200);
	expect(Object.keys(document.paths)).toEqual(["/api/accounts/register"]);
});

test("quickstart: the afora.json validates and generates the same app", async () => {
	const spec = JSON.parse(await read("./quickstart.afora.json"));
	const options = { stages };

	expect(validateSpec(spec, [], options)).toEqual([]);
	const files = generate(spec, [], options);
	const contents = (name: string) =>
		files.find((file) => file.path.endsWith(`/${name}`))?.contents ?? "";

	expect(contents("outputs.ts")).toContain('from "@afora/hono"');
	expect(contents("outputs.ts")).toContain("UserAlreadyExists: 409");
	expect(contents("use-cases.ts")).toContain(
		"class Register extends useCaseOf",
	);
	expect(contents("use-cases.ts")).toContain("../hash-password.ts");
	expect(contents("commands.ts")).toContain("transaction: true");
});
