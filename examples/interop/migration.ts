/**
 * A portfolio CMS API moved to afora, as told in #115 to #124: settings
 * documents keyed by name, articles with the UUID v4 ids of an existing
 * database, items in SQLite with ids the database assigns, a health check,
 * push subscriptions removed by a JSON body, media uploads and a cache.
 */
import { Database } from "bun:sqlite";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	Key,
	listOf,
	outputOf,
	type ProviderOperation,
	propertyOf,
	repositoryOf,
	resourceOf,
	Serial,
	serviceOf,
	Uuid,
	useCaseOf,
	withStatus,
	wrapProvider,
} from "@afora/core";
import { spyProvider } from "@afora/core/testing";
import { drizzleProvider } from "@afora/drizzle";
import { hono } from "@afora/hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Type } from "typebox";

// #123: a custom property whose message reaches the client as written.
const ArticleSlug = propertyOf({
	name: "slug",
	schema: Type.String(),
	afterHandle: (value) => {
		if (!/^[a-z0-9-]+$/.test(value)) {
			throw new Error("Use lowercase letters, numbers and hyphens.");
		}
		return value;
	},
});

// #122: settings documents are keyed by name ("profile", "seo", ...).
export class Setting extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ name: "Setting", id: Key },
) {}

// #122: articles keep the UUID v4 ids of the old database; new ones get a v7.
export const articleInput = blueprintOf((ctx) => ({
	slug: ArticleSlug,
	title: ctx.text,
}));
export class Article extends entityOf(articleInput, {
	name: "Article",
	id: Uuid,
	unique: ["slug"],
}) {}

// #119: a browser push subscription, removed by its endpoint.
export class PushSubscription extends entityOf(
	blueprintOf((ctx) => ({ endpoint: ctx.url, owner: ctx.string })),
	{ name: "PushSubscription", unique: ["endpoint"] },
) {}

// #122: items live in SQLite, which assigns their ids.
export class Item extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text })),
	{ name: "Item", id: Serial },
) {}

const sqlite = new Database(":memory:");
sqlite.run(
	"CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT, name TEXT NOT NULL)",
);
const items = sqliteTable("items", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	name: text("name").notNull(),
});

// #124: every operation of the SQLite provider is traced, transactions included.
export const trace: ProviderOperation[] = [];
const traced = wrapProvider(
	drizzleProvider({ db: drizzle(sqlite), tables: { Item: items } }),
	{
		async around({ operation }, next) {
			trace.push(operation);
			return await next();
		},
	},
);

const Settings = repositoryOf({
	entity: Setting,
	actions: ["findById", "create", "count"],
});
const Articles = repositoryOf({
	entity: Article,
	actions: ["findById", "findMany", "create"],
});
const PushSubscriptions = repositoryOf({
	entity: PushSubscription,
	actions: ["findByEndpoint", "create", "delete"],
});
const Items = repositoryOf({
	entity: Item,
	actions: ["findById", "findPage", "create", "update", "delete"],
	provider: traced,
});

// #120: a declared exception keeps its detail at a 5xx.
export const DbDown = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "DbDown",
	message: "The database is down.",
});

// #115: the cache is a service, given by the application per call.
export interface ContentCache {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
}
export const Cache = serviceOf<ContentCache>("cache");
export const memoryCache = (
	store = new Map<string, unknown>(),
): ContentCache => ({
	get: async (key) => store.get(key),
	set: async (key, value) => {
		store.set(key, value);
	},
});

const nothing = blueprintOf(() => ({}));

// #116: 200 when the database answers, 503 with the same body when not.
class Health extends useCaseOf({
	name: "Health",
	blueprint: nothing,
	response: blueprintOf((ctx) => ({ ok: ctx.boolean, settings: ctx.integer })),
	dependencies: { Settings },
	route: { method: "get", path: "/health", statuses: [503] },
}) {
	override async execute({ Settings = this.dependencies.Settings } = {}) {
		try {
			return { ok: true, settings: await Settings.count() };
		} catch {
			return withStatus(503, { ok: false, settings: -1 });
		}
	}
}

// #120: the same count, without a catch: a failure is a problem.
class CountSettings extends useCaseOf({
	name: "CountSettings",
	blueprint: nothing,
	response: blueprintOf((ctx) => ({ total: ctx.integer })),
	dependencies: { Settings },
	route: { method: "get", path: "/admin/settings/count" },
}) {
	override async execute({ Settings = this.dependencies.Settings } = {}) {
		return { total: await Settings.count() };
	}
}

const NotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "NotFound",
	message: "Not found.",
});

// #122: a settings document by its key.
class GetSetting extends useCaseOf({
	name: "GetSetting",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf((ctx) => ({ id: ctx.string, title: ctx.text })),
	dependencies: { Settings },
	route: { method: "get", path: "/settings/{id}" },
}) {
	override async execute({ Settings = this.dependencies.Settings } = {}) {
		const setting = await Settings.findById(this.input.id);
		if (!setting) throw new NotFound({ source: "GetSetting" });
		return { id: setting.id, title: setting.title };
	}
}

// #117 and #115: a bare array, read through the cache.
const ArticleSummary = blueprintOf((ctx) => ({
	id: ctx.string,
	slug: ctx.string,
	title: ctx.text,
}));
class ListArticles extends useCaseOf({
	name: "ListArticles",
	blueprint: nothing,
	response: listOf(ArticleSummary),
	dependencies: { Articles, cache: Cache },
	route: { method: "get", path: "/articles" },
}) {
	override async execute({
		Articles = this.dependencies.Articles,
		cache = this.dependencies.cache,
	} = {}) {
		const cached = (await cache.get("articles")) as
			| { id: string; slug: string; title: string }[]
			| undefined;
		if (cached) return cached;
		const found = (await Articles.findMany()).map(({ id, slug, title }) => ({
			id,
			slug,
			title,
		}));
		await cache.set("articles", found);
		return found;
	}
}

// #123: a bad slug is a 400 whose message is the one afterHandle threw.
class CreateArticle extends useCaseOf({
	name: "CreateArticle",
	blueprint: articleInput,
	response: ArticleSummary,
	dependencies: { Articles },
	route: { method: "post", path: "/articles", status: 201 },
}) {
	override async execute({ Articles = this.dependencies.Articles } = {}) {
		const { id, slug, title } = await Articles.create(this.input);
		return { id, slug, title };
	}
}

// #122: a legacy article, by its UUID v4.
class GetArticle extends useCaseOf({
	name: "GetArticle",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: ArticleSummary,
	dependencies: { Articles },
	route: { method: "get", path: "/articles/{id}" },
}) {
	override async execute({ Articles = this.dependencies.Articles } = {}) {
		const article = await Articles.findById(this.input.id);
		if (!article) throw new NotFound({ source: "GetArticle" });
		return { id: article.id, slug: article.slug, title: article.title };
	}
}

// #119: DELETE with a JSON body; the owner comes from a header only.
class Unsubscribe extends useCaseOf({
	name: "Unsubscribe",
	blueprint: blueprintOf((ctx) => ({ endpoint: ctx.url, owner: ctx.string })),
	response: blueprintOf((ctx) => ({ removed: ctx.boolean })),
	dependencies: { PushSubscriptions },
	route: {
		method: "delete",
		path: "/push/subscriptions",
		body: true,
		headers: { owner: "x-owner" },
	},
}) {
	override async execute({
		PushSubscriptions = this.dependencies.PushSubscriptions,
	} = {}) {
		const found = await PushSubscriptions.findByEndpoint(this.input.endpoint);
		if (!found || found.owner !== this.input.owner) return { removed: false };
		await PushSubscriptions.delete(found);
		return { removed: true };
	}
}

// #118: a PNG of at most 1 KB, sent as multipart/form-data.
export const MAX_BYTES = 1024;
class UploadMedia extends useCaseOf({
	name: "UploadMedia",
	blueprint: blueprintOf((ctx) => ({
		file: ctx.fileOf({ types: ["image/png"], maxBytes: MAX_BYTES }),
		folder: ctx.optional.string,
	})),
	response: blueprintOf((ctx) => ({
		name: ctx.string,
		type: ctx.string,
		size: ctx.integer,
		folder: ctx.string,
	})),
	route: { method: "post", path: "/admin/media", status: 201 },
}) {
	override async execute() {
		const { file, folder = "media" } = this.input;
		const name = file instanceof File ? file.name : "upload";
		return { name, type: file.type, size: file.size, folder };
	}
}

export const Site = commandOf({
	name: "Site",
	useCases: {
		health: Health,
		getSetting: GetSetting,
		listArticles: ListArticles,
		getArticle: GetArticle,
		unsubscribe: Unsubscribe,
	},
});
export const Admin = commandOf({
	name: "Admin",
	useCases: {
		countSettings: CountSettings,
		createArticle: CreateArticle,
		upload: UploadMedia,
	},
});
// #124: each operation runs in a transaction of the traced provider.
export const Inventory = commandOf({
	name: "Inventory",
	transaction: true,
	useCases: resourceOf(Items, { path: "/items", actions: ["create", "get"] }),
});

const Api = outputOf({
	name: "Api",
	commands: [Site, Admin, Inventory],
	statuses: { DbDown: 503, NotFound: 404 },
	pipe: [
		hono({
			docs: {
				path: "/openapi.json",
				info: { title: "Portfolio CMS", version: "1.0.0" },
			},
		}),
	],
});

/** One application per test: its own spy, cache and in-memory store. */
export function cmsOf() {
	const spy = spyProvider(inMemoryProvider());
	const cacheStore = new Map<string, unknown>();
	const app = applicationOf({
		name: "cms",
		entities: { Setting, Article, PushSubscription, Item },
		repositories: { Settings, Articles, PushSubscriptions, Items },
		useCases: {
			Health,
			CountSettings,
			GetSetting,
			ListArticles,
			CreateArticle,
			GetArticle,
			Unsubscribe,
			UploadMedia,
		},
		commands: { Site, Admin, Inventory },
		outputs: { Api },
		provider: spy,
		services: { cache: () => memoryCache(cacheStore) },
	});
	return { app, spy, api: app.outputs.Api.build() };
}

if (import.meta.main) Bun.serve({ fetch: cmsOf().api.fetch });
