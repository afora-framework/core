import { expect, test } from "bun:test";

process.env.JWT_SECRET = "a-secret-of-at-least-thirty-two-characters";
const { api } = await import("./tutorial.ts");

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const send = (method: string, path: string, body?: unknown, token?: string) =>
	api.request(path, {
		method,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const signIn = async (email: string, roles: string[]) => {
	const password = "Str0ng!Pass";
	await send("POST", "/users", { name: "Ana", email, password, roles });
	const login = await send("POST", "/login", { email, password });
	return (await login.json()) as { token: string; user: { id: string } };
};

test("tutorial: the docs show the code of tutorial.ts", async () => {
	const source = (await read("./tutorial.ts")).trim();

	expect(await read("../../docs/tutorial.md")).toContain(source);
});

test("tutorial: register, login and a masked password", async () => {
	const created = await send("POST", "/users", {
		name: "Bia",
		email: "bia@example.com",
		password: "Str0ng!Pass",
		roles: [],
	});
	expect(created.status).toBe(201);
	const { item } = (await created.json()) as { item: Record<string, string> };
	expect(item.password).toBe("********");

	const wrong = await send("POST", "/login", {
		email: "bia@example.com",
		password: "nope",
	});
	expect(wrong.status).toBe(401);
});

test("tutorial: access is enforced before the use case runs", async () => {
	const post = {
		title: "Hello",
		slug: "hello",
		body: "First.",
		authorId: "x",
		published: false,
	};
	expect((await send("POST", "/posts", post)).status).toBe(401);
	const reader = await signIn("reader@example.com", []);
	expect((await send("POST", "/posts", post, reader.token)).status).toBe(403);
	// Reading stays open: it declares no access.
	expect((await send("GET", "/posts")).status).toBe(200);
});

test("tutorial: the rule of the use case, with its statuses", async () => {
	const author = await signIn("author@example.com", ["posts:write"]);
	const other = await signIn("other@example.com", ["posts:write"]);
	const created = await send(
		"POST",
		"/posts",
		{
			title: "Mine",
			slug: "mine",
			body: "Draft.",
			authorId: author.user.id,
			published: false,
		},
		author.token,
	);
	expect(created.status).toBe(201);

	expect(
		(await send("POST", "/posts/none/publish", undefined, author.token)).status,
	).toBe(404);
	const refused = await send(
		"POST",
		"/posts/mine/publish",
		undefined,
		other.token,
	);
	expect(refused.status).toBe(403);
	expect(((await refused.json()) as { title: string }).title).toBe(
		"NotTheAuthor",
	);
	const published = await send(
		"POST",
		"/posts/mine/publish",
		undefined,
		author.token,
	);
	expect(published.status).toBe(200);
	expect(
		((await published.json()) as { post: { published: boolean } }).post
			.published,
	).toBe(true);
});

test("tutorial: the document says who may call what", async () => {
	const document = (await (await api.request("/openapi.json")).json()) as {
		paths: Record<string, Record<string, { security?: unknown }>>;
		components: { securitySchemes: object };
	};

	expect(Object.keys(document.components.securitySchemes)).toEqual(["bearer"]);
	expect(document.paths["/posts/{slug}/publish"]?.post?.security).toEqual([
		{ bearer: ["posts:write"] },
	]);
	expect(document.paths["/posts"]?.get).not.toHaveProperty("security");
});
