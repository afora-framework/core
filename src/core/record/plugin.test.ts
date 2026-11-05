import { describe, expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { recordOf as stdRecordOf } from "../../std/record";
import {
	Authenticatable,
	Publishable,
	StdRecordPlugins,
	Taggable,
} from "../../std/record-plugins";
import { Exception } from "../exception/exception";
import { inMemoryProvider } from "../repository/in-memory";
import { repositoryOf } from "../repository/repository";
import {
	IncompatibleRecordPlugin,
	InvalidRecordPlugin,
	RecordPluginConflict,
	ReservedRecordKey,
	UnknownRecordPlugin,
} from "./exceptions";
import { MASK } from "./mask";
import { hasPlugin, pluginsOf, recordPluginOf } from "./plugin";
import { recordPluginCatalogOf } from "./plugin-catalog";
import { recordOf } from "./record";
import type { RecordEffects } from "./types/record.interface";

function raise(run: () => unknown): Exception {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error;
		throw error;
	}
	throw new Error("expected an exception");
}

const effects: string[] = [];

class SluggedRecord extends recordOf(
	blueprintOf((ctx) => ({ slug: ctx.slug, secret: ctx.optional.string })),
	{ sensitive: ["secret"], change: ["slug"] },
) {
	get path(): string {
		return `/${this.slug}`;
	}

	rename(title: string): this {
		return this.set("slug", title);
	}

	protected override onSet(): RecordEffects<SluggedRecord> {
		return { slug: (value) => effects.push(`slug:${value}`) };
	}
}
const Slugged = recordPluginOf("slugged", SluggedRecord, { version: "1.2.0" });

const PostBlueprint = blueprintOf((ctx) => ({ title: ctx.string }));

describe("recordPluginOf", () => {
	test("takes the keys, options and members of the record class", () => {
		expect(Slugged.name).toBe("slugged");
		expect(Slugged.version).toBe("1.2.0");
		expect(Slugged.keys).toEqual(["slug", "secret"]);
		expect(Slugged.members).toEqual(["path", "rename"]);
		expect(Slugged.options).toEqual({
			sensitive: ["secret"],
			unique: ["slug"],
			change: ["slug"],
		});
		expect(Slugged.requires).toEqual([]);
	});

	test("rejects what is not a record class, an entity, and a bad version", () => {
		const notRecord = raise(() => recordPluginOf("x", class {} as never));
		expect(notRecord).toBeInstanceOf(InvalidRecordPlugin);

		class User extends entityOf(PostBlueprint) {}
		expect(
			raise(() => recordPluginOf("user", User as never)).message,
		).toContain("not an entity");
		expect(
			raise(() => recordPluginOf("x", SluggedRecord, { version: "1" })),
		).toBeInstanceOf(InvalidRecordPlugin);
		expect(raise(() => recordPluginOf("", SluggedRecord))).toBeInstanceOf(
			InvalidRecordPlugin,
		);
	});

	test("rejects a class replacing a member of every record", () => {
		class Bad extends recordOf(PostBlueprint) {
			override toJSON() {
				return super.toJSON();
			}
		}
		expect(raise(() => recordPluginOf("bad", Bad))).toBeInstanceOf(
			InvalidRecordPlugin,
		);
	});
});

describe("options.plugins", () => {
	class Post extends recordOf(PostBlueprint, { plugins: [Slugged] }) {}

	test("adds the keys, options and members of the plugins", () => {
		const post = new Post({ title: "Hi", slug: "Olá Mundo", secret: "s" });
		expect(post.title).toBe("Hi");
		expect(post.slug).toBe("ola-mundo");
		expect(post.path).toBe("/ola-mundo");
		expect(Object.keys(Post.blueprint.properties)).toEqual([
			"title",
			"slug",
			"secret",
		]);
		expect(Post.options).toEqual({
			sensitive: ["secret"],
			unique: ["slug"],
			change: ["slug"],
		});
		expect(post.toJSON()).toEqual({
			title: "Hi",
			slug: "ola-mundo",
			secret: MASK,
		});
		expect(Post.plugins).toEqual([Slugged]);

		expectTypeOf(post.slug).toEqualTypeOf<string>();
		expectTypeOf(post.secret).toEqualTypeOf<string | undefined>();
		expectTypeOf(post.path).toEqualTypeOf<string>();
	});

	test("its methods change the record and run its onSet, then the record's", () => {
		effects.length = 0;
		class Tracked extends recordOf(PostBlueprint, { plugins: [Slugged] }) {
			protected override onSetAll(): void {
				effects.push("record");
			}
		}
		const post = new Tracked({ title: "Hi", slug: "a" });
		const renamed = post.rename("New Name");
		expect(renamed).toBe(post);
		expect(post.slug).toBe("new-name");
		post.change.slug("b");
		expect(effects).toEqual(["slug:new-name", "record", "slug:b", "record"]);

		expectTypeOf(renamed).toEqualTypeOf<Tracked>();
		expectTypeOf(post.change.slug("c")).toEqualTypeOf<Tracked>();
	});

	test("rejects a key or member the record, or another plugin, has", () => {
		const Title = recordPluginOf(
			"title",
			recordOf(blueprintOf((ctx) => ({ title: ctx.string }))),
		);
		const key = raise(() => recordOf(PostBlueprint, { plugins: [Title] }));
		expect(key).toBeInstanceOf(RecordPluginConflict);
		expect(key.details).toEqual({
			plugin: "title",
			key: "title",
			owner: 'record "record"',
		});

		class Other extends recordOf(
			blueprintOf((ctx) => ({ other: ctx.string })),
		) {
			path(): string {
				return "";
			}
		}
		const member = raise(() =>
			recordOf(PostBlueprint, {
				plugins: [Slugged, recordPluginOf("other", Other)],
			}),
		);
		expect(member.details).toEqual({
			plugin: "other",
			key: "path",
			owner: 'plugin "slugged"',
		});

		const twin = recordPluginOf("slugged", SluggedRecord);
		expect(
			raise(() => recordOf(PostBlueprint, { plugins: [Slugged, twin] })),
		).toBeInstanceOf(RecordPluginConflict);
	});

	test("a class extending the record cannot hide a plugin key", () => {
		class Hiding extends recordOf(PostBlueprint, { plugins: [Slugged] }) {
			// @ts-expect-error: the key of a plugin cannot be hidden either
			slug(): string {
				return "";
			}
		}
		expect(
			raise(() => new Hiding({ title: "a", slug: "a" } as never)),
		).toBeInstanceOf(ReservedRecordKey);
	});

	test("applies the plugins a plugin requires, each once", () => {
		class Article extends recordOf(
			blueprintOf((ctx) => ({ summary: ctx.optional.string })),
			{ plugins: [Slugged] },
		) {
			describe(): string {
				return `${this.path}: ${this.summary ?? ""}`;
			}
		}
		const Articled = recordPluginOf("article", Article);
		expect(Articled.keys).toEqual(["summary"]);
		expect(Articled.requires).toEqual([Slugged]);

		class Page extends recordOf(PostBlueprint, {
			plugins: [Articled, Slugged],
		}) {}
		expect(Page.plugins).toEqual([Slugged, Articled]);
		const page = new Page({ title: "T", slug: "page", summary: "s" });
		expect(page.describe()).toBe("/page: s");
		expect(hasPlugin(page, Slugged)).toBe(true);
		expectTypeOf(page.path).toEqualTypeOf<string>();
	});

	test("picks from the catalogs of the builder", () => {
		class Post extends stdRecordOf(PostBlueprint, {
			plugins: (ctx) => [ctx.publishable, ctx.taggable],
		}) {}
		const post = new Post({ title: "Hi" });
		expect(post.isPublished).toBe(false);
		post.publish("2026-01-01T00:00:00.000Z").tag("a", "b", "a");
		expect(post.publishedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(post.tags).toEqual(["a", "b"]);
		expect(post.untag("a").hasTag("a")).toBe(false);
		expect(Post.plugins).toEqual([Publishable, Taggable]);
		expectTypeOf(post.publish()).toEqualTypeOf<Post>();
	});
});

describe("tracking", () => {
	class Post extends recordOf(PostBlueprint, { plugins: [Slugged] }) {}
	class Plain extends recordOf(PostBlueprint) {}

	test("hasPlugin and plugin.is tell records, entities and classes with a plugin", () => {
		const post = new Post({ title: "a", slug: "a" });
		expect(hasPlugin(post, Slugged)).toBe(true);
		expect(Slugged.is(post)).toBe(true);
		expect(hasPlugin(Post, Slugged)).toBe(true);
		expect(hasPlugin(post, "slugged")).toBe(true);
		expect(hasPlugin(new Plain({ title: "a" }), Slugged)).toBe(false);
		expect(hasPlugin(new SluggedRecord({ slug: "a" }), Slugged)).toBe(true);
		expect(hasPlugin({}, Slugged)).toBe(false);
		expect(hasPlugin(undefined, Slugged)).toBe(false);
		expect(pluginsOf(post)).toEqual([Slugged]);

		class Sub extends Post {}
		expect(hasPlugin(new Sub({ title: "a", slug: "a" }), Slugged)).toBe(true);

		const unknown: unknown = post;
		if (Slugged.is(unknown)) expectTypeOf(unknown.path).toEqualTypeOf<string>();
	});
});

describe("entities", () => {
	class User extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.string })),
		{
			plugins: (ctx) => [ctx.authenticatable],
			onUpdate: () => [],
		},
	) {}
	const hash =
		"$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

	test("take plugins, whose changes set updatedAt", () => {
		const user = new User({
			name: "Jane",
			email: "jane@x.com",
			password: hash,
		});
		expect(User.options.unique).toEqual(["id", "email"]);
		expect(User.options.sensitive).toEqual(["password"]);
		expect(user.toJSON().password).toBe(MASK);
		expect(user.updatedAt).toBeUndefined();
		user.change.password(hash);
		expect(user.updatedAt).toBeString();
		expect(hasPlugin(user, Authenticatable)).toBe(true);
		expectTypeOf(user.verifyPassword).toEqualTypeOf<
			(plain: string) => Promise<boolean>
		>();
	});

	test("a plugin key cannot be an identity key", () => {
		const Identified = recordPluginOf(
			"identified",
			recordOf(blueprintOf((ctx) => ({ id: ctx.string }))),
		);
		expect(
			raise(() =>
				entityOf(
					blueprintOf((ctx) => ({ name: ctx.string })),
					{
						plugins: [Identified],
					},
				),
			),
		).toBeInstanceOf(RecordPluginConflict);
	});

	test("repositories find them by the unique keys of their plugins", async () => {
		const Users = repositoryOf({
			entity: User,
			actions: ["create", "findByEmail"],
			provider: inMemoryProvider(),
		});
		await Users.create({ name: "Jane", email: "jane@x.com", password: hash });
		const found = await Users.findByEmail("jane@x.com");
		expect(found?.name).toBe("Jane");
		expect(found && hasPlugin(found, Authenticatable)).toBe(true);
	});
});

describe("serialization", () => {
	const Catalog = recordPluginCatalogOf(Slugged, ...StdRecordPlugins.list);

	test("a plugin is its descriptor in JSON", () => {
		expect(JSON.parse(JSON.stringify(Slugged))).toEqual({
			kind: "record-plugin",
			name: "slugged",
			version: "1.2.0",
			keys: ["slug", "secret"],
			sensitive: ["secret"],
			unique: ["slug"],
			change: ["slug"],
			members: ["path", "rename"],
			requires: [],
		});
	});

	test("a catalog resolves descriptors, names and versions back to plugins", () => {
		class Post extends recordOf(PostBlueprint, {
			plugins: [Slugged, Publishable],
		}) {}
		const json = JSON.parse(JSON.stringify(Post.plugins));
		const plugins = Catalog.resolveAll(json);
		expect(plugins).toEqual([Slugged, Publishable]);

		class Rebuilt extends recordOf(PostBlueprint, { plugins }) {}
		expect(Rebuilt.blueprint.properties).toEqual(Post.blueprint.properties);
		expect(Rebuilt.options).toEqual(Post.options as typeof Rebuilt.options);

		expect(Catalog.resolve("slugged")).toBe(Slugged);
		expect(Catalog.resolve("slugged@1.0.0")).toBe(Slugged);
		expect(Catalog.plugins.slugged).toBe(Slugged);
	});

	test("rejects unknown and incompatible references", () => {
		expect(raise(() => Catalog.resolve("nope"))).toBeInstanceOf(
			UnknownRecordPlugin,
		);
		expect(raise(() => Catalog.resolve("slugged@2.0.0"))).toBeInstanceOf(
			IncompatibleRecordPlugin,
		);
		expect(raise(() => Catalog.resolve("slugged@1.3.0"))).toBeInstanceOf(
			IncompatibleRecordPlugin,
		);
		const descriptor = Slugged.toJSON();
		const missing = raise(() =>
			Catalog.resolve({ ...descriptor, members: ["path", "gone"] }),
		);
		expect(missing).toBeInstanceOf(IncompatibleRecordPlugin);
		expect(missing.message).toContain('"gone" is not in its members');
		expect(
			raise(() => Catalog.resolve({ name: "slugged" } as never)),
		).toBeInstanceOf(IncompatibleRecordPlugin);
	});

	test("a catalog rejects two plugins with the same name", () => {
		expect(
			raise(() =>
				recordPluginCatalogOf(
					Slugged,
					recordPluginOf("slugged", SluggedRecord),
				),
			),
		).toBeInstanceOf(InvalidRecordPlugin);
	});
});
