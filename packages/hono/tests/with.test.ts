import { describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	environmentOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	serviceOf,
	useCaseOf,
} from "@afora/core";
import type { Hono } from "hono";
import { hono } from "../src/index";

class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
const Posts = repositoryOf({ entity: Post, actions: ["create", "findMany"] });
const Mailer = serviceOf<{ send(to: string, text: string): string }>("mailer");
// No variables in the process: only a replacement gives them.
const Mail = environmentOf(
	blueprintOf((ctx) => ({ MAIL_TO: ctx.email })),
	{
		source: () => ({}),
	},
);

/** Mails the editors: a child of `Publish`, with the service and the environment. */
class Notify extends useCaseOf({
	name: "Notify",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text })),
	response: blueprintOf((ctx) => ({ receipt: ctx.string })),
	dependencies: { mailer: Mailer, mail: Mail },
}) {
	override async execute() {
		const { mailer, mail } = this.dependencies;
		return { receipt: mailer.send(mail.MAIL_TO, this.input.title) };
	}
}
/** Counts the posts: a child of `Publish` and of `Feed`, with the repository. */
class Count extends useCaseOf({
	name: "Count",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ count: ctx.integer })),
	dependencies: { posts: Posts },
}) {
	override async execute() {
		return { count: (await this.dependencies.posts.findMany()).length };
	}
}
class Publish extends useCaseOf({
	name: "Publish",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text })),
	response: blueprintOf((ctx) => ({
		post: Post,
		receipt: ctx.string,
		count: ctx.integer,
	})),
	dependencies: { posts: Posts, notify: Notify, count: Count },
}) {
	override async execute() {
		const { posts, notify, count } = this.dependencies;
		const post = await posts.create(new Post({ title: this.input.title }));
		const { receipt } = await notify({ title: post.title });
		return { post, receipt, count: (await count({})).count };
	}
}
class Feed extends useCaseOf({
	name: "Feed",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ count: ctx.integer })),
	dependencies: { count: Count },
}) {
	override async execute() {
		return this.dependencies.count({});
	}
}

const PostsCommand = commandOf({
	name: "Posts",
	useCases: { publish: Publish, feed: Feed },
});
const Api = outputOf({
	name: "Api",
	commands: [PostsCommand],
	pipe: [hono({ route: { "Posts.feed": { method: "get" } } })],
});

const Blog = applicationOf({
	name: "blog",
	entities: { Post },
	environments: { Mail },
	repositories: { Posts },
	useCases: { Notify, Count, Publish, Feed },
	commands: { Posts: PostsCommand },
	outputs: { Api },
	provider: inMemoryProvider(),
	services: {
		mailer: () => ({
			send: () => {
				throw new Error("No mail is sent from a test.");
			},
		}),
	},
});

describe("app.with through a Hono output", () => {
	test("a service, an environment and a repository replaced, reached by nested use cases", async () => {
		const sent: string[] = [];
		const app = Blog.with({
			services: {
				mailer: () => ({
					send: (to: string, text: string) => {
						sent.push(`${to}: ${text}`);
						return `sent to ${to}`;
					},
				}),
			},
			environments: { Mail: { MAIL_TO: "editors@example.com" } },
			repositories: {
				Posts: {
					findMany: async () => [
						new Post({ title: "one" }),
						new Post({ title: "two" }),
						new Post({ title: "three" }),
					],
				},
			},
		});
		await app.start({ register: false });
		const http = app.outputs.Api.build() as Hono;

		const published = await http.request("/posts/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Hello" }),
		});
		expect(published.status).toBe(200);
		expect(await published.json()).toMatchObject({
			post: { title: "Hello" },
			receipt: "sent to editors@example.com",
			count: 3,
		});
		expect(sent).toEqual(["editors@example.com: Hello"]);

		const feed = await http.request("/posts/feed");
		expect(feed.status).toBe(200);
		expect(await feed.json()).toEqual({ count: 3 });

		// `create` was not replaced: the post is in the store.
		const stored = await app.repository(Posts).create(new Post({ title: "x" }));
		expect(stored.title).toBe("x");
		await app.stop();
	});

	test("the application it comes from is left as it is", async () => {
		const http = Blog.outputs.Api.build() as Hono;
		const response = await http.request("/posts/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Hello" }),
		});
		expect(response.status).toBe(500);
	});
});
