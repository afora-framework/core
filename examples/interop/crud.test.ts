import { expect, test } from "bun:test";
import { api } from "./crud.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const json = (method: string, body?: unknown) => ({
	method,
	headers: { "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const hello = { title: "Hello", slug: "hello", body: "First post." };

test("crud: the docs open with the code of crud.ts", async () => {
	const source = (await read("./crud.ts")).trim();

	expect(await read("../../docs/README.md")).toContain(source);
	expect(await read("../../docs/tutorial.md")).toContain(source);
});

test("crud: the five operations of the resource", async () => {
	const created = await api.request("/posts", json("POST", hello));
	const { item } = (await created.json()) as { item: Record<string, string> };
	expect(created.status).toBe(201);
	expect(item.slug).toBe("hello");

	const found = await api.request(`/posts/${item.id}`);
	expect(((await found.json()) as { item: { title: string } }).item.title).toBe(
		"Hello",
	);

	const listed = await api.request("/posts?limit=10");
	expect(((await listed.json()) as { total: number }).total).toBe(1);

	const changed = await api.request(
		`/posts/${item.id}`,
		json("PATCH", { title: "Hello again" }),
	);
	expect(
		((await changed.json()) as { item: { title: string } }).item.title,
	).toBe("Hello again");

	expect((await api.request(`/posts/${item.id}`, json("DELETE"))).status).toBe(
		200,
	);
	expect((await api.request(`/posts/${item.id}`)).status).toBe(404);
});

test("crud: what the declarations guarantee, with no code for it", async () => {
	await api.request("/posts", json("POST", { ...hello, slug: "twice" }));
	const duplicate = await api.request(
		"/posts",
		json("POST", { ...hello, slug: "twice" }),
	);
	expect(duplicate.status).toBe(409);
	expect(duplicate.headers.get("content-type")).toContain(
		"application/problem+json",
	);

	const invalid = await api.request(
		"/posts",
		json("POST", { title: "No body", slug: "no-body", extra: true }),
	);
	const problem = (await invalid.json()) as { issues: { path: string[] }[] };
	expect(invalid.status).toBe(400);
	expect(problem.issues.map((issue) => issue.path.join("."))).toEqual([
		"extra",
		"body",
	]);
});

test("crud: the OpenAPI document has the same routes", async () => {
	const document = (await (await api.request("/openapi.json")).json()) as {
		paths: Record<string, object>;
	};

	expect(
		Object.entries(document.paths).map(([path, methods]) => [
			path,
			Object.keys(methods),
		]),
	).toEqual([
		["/posts", ["post", "get"]],
		["/posts/{id}", ["get", "patch", "delete"]],
	]);
});
