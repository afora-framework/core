import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// What a post is: each field validates and normalizes its value
export class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug, body: ctx.text })),
	{ unique: ["slug"], change: ["title", "body"] },
) {}

// Where posts are kept: in memory, until you name a provider
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "findPage", "create", "update", "delete"],
});

// What can be done with them: the five operations of a REST resource
const Blog = commandOf({
	name: "Blog",
	useCases: resourceOf(Posts, { path: "/posts" }),
});

// How they are served: an HTTP API, with its OpenAPI document
const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [
		hono({
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		}),
	],
});

export const api = Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
