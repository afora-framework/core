import { expect, test } from "bun:test";
import { type Exception, MASK, Password } from "../../src/index.ts";
import { app, changePassword, User } from "./quickstart.ts";

const body = {
	email: "  Jane@Example.COM ",
	slug: "Olá Mundo",
	plainPassword: "Str0ng!Pass",
	address: { street: "Main St", zip: "01310-100" },
	tags: ["a", "b"],
};

const post = (value: unknown) =>
	app.request("/users", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});

test("quickstart: the README shows the code of quickstart.ts", async () => {
	const source = await Bun.file(
		new URL("./quickstart.ts", import.meta.url),
	).text();
	const readme = await Bun.file(
		new URL("../../README.md", import.meta.url),
	).text();

	expect(readme).toContain(
		source.trim().replace('"../../src/index.ts"', '"@afora/core"'),
	);
});

test("quickstart: a body becomes a saved user, password masked", async () => {
	const response = await post(body);

	expect(response.status).toBe(201);
	expect(await response.json()).toEqual({
		email: "jane@example.com",
		slug: "ola-mundo",
		password: MASK,
		address: { street: "Main St", zip: "01310-100" },
		tags: ["a", "b"],
	});
	expect(User.options.unique).toEqual(["email", "slug"]);
});

test("quickstart: the repository enforces the unique keys", async () => {
	const response = await post({ ...body, email: "other@example.com" });

	// same slug: the repository throws, and Hono answers 500 as nothing handles it
	expect(response.status).toBe(500);
});

test("quickstart: an invalid body is a 400 with issue paths", async () => {
	const response = await post({ ...body, email: "nope", tags: "x" });
	const result = (await response.json()) as { error: { path: unknown[] }[] };

	expect(response.status).toBe(400);
	expect(result.error.map((issue) => issue.path)).toEqual([
		["email"],
		["tags"],
	]);
});

test("quickstart: an error carries its trace across layers", () => {
	const user = new User({
		email: "a@b.co",
		slug: "a",
		password: Password.demo().value,
		address: { street: "s", zip: "z" },
		tags: [],
	});

	let thrown: Exception | undefined;
	try {
		changePassword(user, "plain text");
	} catch (error) {
		thrown = error as Exception;
	}

	expect(
		thrown?.trace.map((frame) => `${frame.layer}:${frame.source}`),
	).toEqual([
		"property:password",
		"record:User",
		"use-case:ChangePassword",
		"output:PATCH /password",
	]);
});
