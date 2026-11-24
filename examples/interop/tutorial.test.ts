import { expect, test } from "bun:test";
import { testApplicationOf } from "@afora/core/testing";

process.env.JWT_SECRET = "a-secret-of-at-least-thirty-two-characters";
const { App } = await import("./tutorial.ts");

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/** Requests to the API of `app`, and a user that signs in. */
const clientOf = (app: typeof App) => {
	const api = app.outputs.Api.build();
	const send = (method: string, path: string, body?: unknown, token?: string) =>
		api.request(path, {
			method,
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const signIn = async (email: string) => {
		const password = "Str0ng!Pass";
		await send("POST", "/users", { name: "Ana", email, password });
		const login = await send("POST", "/login", { email, password });
		return (await login.json()) as { token: string; user: { id: string } };
	};
	return { api, send, signIn };
};

test("tutorial: the docs show the code of tutorial.ts", async () => {
	const source = (await read("./tutorial.ts")).trim();

	expect(await read("../../docs/tutorial.md")).toContain(source);
});

test("tutorial: register, login and a masked password", async () => {
	// An application of its own: no user and no post of another test.
	await using app = await testApplicationOf(App);
	const { send } = clientOf(app);

	const created = await send("POST", "/users", {
		name: "Bia",
		email: "bia@example.com",
		password: "Str0ng!Pass",
	});
	expect(created.status).toBe(201);
	const { item } = (await created.json()) as {
		item: Record<string, unknown>;
	};
	expect(item.password).toBe("********");
	// The roles are set by `register`, never taken from the body.
	expect(item.roles).toEqual(["posts:write"]);
	const granting = await send("POST", "/users", {
		name: "Eve",
		email: "eve@example.com",
		password: "Str0ng!Pass",
		roles: ["admin"],
	});
	expect(granting.status).toBe(400);

	const wrong = await send("POST", "/login", {
		email: "bia@example.com",
		password: "nope",
	});
	expect(wrong.status).toBe(401);
});

test("tutorial: access is enforced before the use case runs", async () => {
	// An application of its own: no user and no post of another test.
	await using app = await testApplicationOf(App);
	const { send } = clientOf(app);

	const post = { title: "Hello", slug: "hello", body: "First." };
	expect((await send("POST", "/posts", post)).status).toBe(401);
	expect(
		(await send("POST", "/posts/hello/publish", undefined, "not-a-token"))
			.status,
	).toBe(401);
	// Reading stays open: it declares no access.
	expect((await send("GET", "/posts")).status).toBe(200);
});

test("tutorial: the rule of the use case, with its statuses", async () => {
	// An application of its own: no user and no post of another test.
	await using app = await testApplicationOf(App);
	const { send, signIn } = clientOf(app);

	const author = await signIn("author@example.com");
	const other = await signIn("other@example.com");
	const created = await send(
		"POST",
		"/posts",
		{ title: "Mine", slug: "mine", body: "Draft." },
		author.token,
	);
	expect(created.status).toBe(201);
	// The author is the caller and a new post is a draft: neither comes from the body.
	const { item } = (await created.json()) as {
		item: { authorId: string; published: boolean };
	};
	expect(item).toMatchObject({ authorId: author.user.id, published: false });
	const spoofed = await send(
		"POST",
		"/posts",
		{ title: "Theirs", slug: "theirs", body: "x", authorId: other.user.id },
		author.token,
	);
	expect(spoofed.status).toBe(400);

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
	// An application of its own: no user and no post of another test.
	await using app = await testApplicationOf(App);
	const { api } = clientOf(app);

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
