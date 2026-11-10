import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EventDefinition,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	optionalOf,
	outputOf,
	Password,
	publishEvents,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { type WebSocketOptions, websocket, wsHub } from "../src/index";

const Forbidden = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Forbidden",
	message: "Not yours.",
});

/** Posts that raise `published` on create, with a sensitive key, served over WebSocket; events go to `topic`. */
export function realtime(options: WebSocketOptions = {}, topic = "feed") {
	class Post extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			author: ctx.string,
			secret: ctx.password,
		})),
		{ onCreate: () => Published },
	) {}
	const Published: EventDefinition = eventOf("published", Post, async () => {});
	const Posts = repositoryOf({ entity: Post, actions: ["create", "findMany"] });

	class Create extends useCaseOf({
		name: "Create",
		description: "Publishes a post.",
		blueprint: blueprintOf((ctx) => ({ title: ctx.text })),
		response: blueprintOf(() => ({ post: Post })),
		context: blueprintOf((ctx) => ({ author: optionalOf(ctx.string) })),
		dependencies: { posts: Posts },
		errors: [Forbidden],
	}) {
		override async execute({ posts = this.dependencies.posts } = {}) {
			if (this.input.title === "forbidden") {
				throw new Forbidden({ source: "Create" });
			}
			const post = new Post({
				title: this.input.title,
				author: this.context.author ?? "anonymous",
				secret: (await Password.hash("Str0ng!Pass")).value,
			});
			return { post: await posts.create(post) };
		}
	}
	class Count extends useCaseOf({
		name: "Count",
		blueprint: blueprintOf(() => ({})),
		response: blueprintOf((ctx) => ({ total: ctx.integer })),
		dependencies: { posts: Posts },
	}) {
		override async execute({ posts = this.dependencies.posts } = {}) {
			return { total: (await posts.findMany()).length };
		}
	}

	const PostsCommand = commandOf({
		name: "Posts",
		useCases: { create: Create, count: Count },
		events: publishEvents({ publisher: "realtime", topic }),
	});
	const hub = wsHub();
	const Live = outputOf({
		name: "Live",
		commands: [PostsCommand],
		statuses: { Forbidden: 403 },
		pipe: [
			websocket(
				// A key given as undefined is left out: options are JSON.
				Object.fromEntries(
					Object.entries({
						context: { author: "x-user" },
						subscriptions: { topics: ["posts/*", "feed"] },
						...options,
					}).filter(([, value]) => value !== undefined),
				) as WebSocketOptions,
			),
		],
	});
	const App = applicationOf({
		name: "live",
		entities: { Post },
		repositories: { Posts },
		useCases: { Create, Count },
		commands: { Posts: PostsCommand },
		outputs: { Live },
		exceptions: { Forbidden },
		publishers: { realtime: hub },
	});
	return { App, hub, endpoint: App.outputs.Live.build() };
}

/** A socket that keeps what it is sent. */
export function fakeSocket() {
	const sent: unknown[] = [];
	return {
		sent,
		send(text: string) {
			sent.push(JSON.parse(text));
		},
	};
}
