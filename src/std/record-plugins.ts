import { recordPluginOf } from "../core/record/plugin";
import { recordPluginCatalogOf } from "../core/record/plugin-catalog";
import { recordOf } from "../core/record/record";
import { blueprintOf } from "./blueprint";
import { Password } from "./properties/password";

/** The current date and time, as `DateTime` accepts it. */
const now = (): string => new Date().toISOString();

/**
 * A `publishedAt` absent while the record is a draft; `publish(at?)` sets it
 * (to now by default), `unpublish()` clears it, `isPublished` tells.
 *
 * @public Exported so declarations can name the plugin's class.
 */
export class PublishableRecord extends recordOf(
	blueprintOf((ctx) => ({ publishedAt: ctx.optional.dateTime })),
) {
	/** Whether `publish` was called, and `unpublish` not since. */
	get isPublished(): boolean {
		return this.publishedAt !== undefined;
	}

	/** Sets `publishedAt` to `at`, now by default. */
	publish(at: string = now()): this {
		return this.set("publishedAt", at);
	}

	/** Clears `publishedAt`, making the record a draft again. */
	unpublish(): this {
		return this.set("publishedAt", undefined);
	}
}

/** A `publishedAt`, with `publish`, `unpublish` and `isPublished`. */
export const Publishable = recordPluginOf("publishable", PublishableRecord, {
	description: "A publication date, with publish, unpublish and isPublished.",
});

/**
 * An `archivedAt` absent while the record is active; `archive(at?)` sets it,
 * `restore()` clears it, `isArchived` tells.
 *
 * @public Exported so declarations can name the plugin's class.
 */
export class ArchivableRecord extends recordOf(
	blueprintOf((ctx) => ({ archivedAt: ctx.optional.dateTime })),
) {
	/** Whether `archive` was called, and `restore` not since. */
	get isArchived(): boolean {
		return this.archivedAt !== undefined;
	}

	/** Sets `archivedAt` to `at`, now by default. */
	archive(at: string = now()): this {
		return this.set("archivedAt", at);
	}

	/** Clears `archivedAt`. */
	restore(): this {
		return this.set("archivedAt", undefined);
	}
}

/** An `archivedAt`, with `archive`, `restore` and `isArchived`. */
export const Archivable = recordPluginOf("archivable", ArchivableRecord, {
	description: "An archive date, with archive, restore and isArchived.",
});

/**
 * `tags`, a list of strings, each once; `tag`, `untag` and `hasTag` change and read it.
 *
 * @public Exported so declarations can name the plugin's class.
 */
export class TaggableRecord extends recordOf(
	blueprintOf((ctx) => ({ tags: ctx.list.optional.string })),
) {
	/** Whether `tag` is one of `tags`. */
	hasTag(tag: string): boolean {
		return this.tags?.includes(tag) ?? false;
	}

	/** Adds each of `tags` that the record does not have yet. */
	tag(...tags: string[]): this {
		return this.set("tags", [...new Set([...(this.tags ?? []), ...tags])]);
	}

	/** Removes each of `tags`. */
	untag(...tags: string[]): this {
		return this.set(
			"tags",
			(this.tags ?? []).filter((tag) => !tags.includes(tag)),
		);
	}
}

/** `tags`, with `tag`, `untag` and `hasTag`. */
export const Taggable = recordPluginOf("taggable", TaggableRecord, {
	description: "A list of tags, with tag, untag and hasTag.",
});

/**
 * An `ownerId`, the id of who owns the record, with `isOwnedBy` and `transferTo`.
 *
 * @public Exported so declarations can name the plugin's class.
 */
export class OwnableRecord extends recordOf(
	blueprintOf((ctx) => ({ ownerId: ctx.id })),
) {
	/** Whether `id` is the id of the owner. */
	isOwnedBy(id: string): boolean {
		return this.ownerId === id.toLowerCase();
	}

	/** Makes `id` the owner. */
	transferTo(id: string): this {
		return this.set("ownerId", id);
	}
}

/** An `ownerId`, with `isOwnedBy` and `transferTo`. */
export const Ownable = recordPluginOf("ownable", OwnableRecord, {
	description: "The id of the owner, with isOwnedBy and transferTo.",
});

/**
 * An `email`, unique, and a `password` hash, sensitive, changed by
 * `change.password` and checked by `verifyPassword`.
 *
 * @public Exported so declarations can name the plugin's class.
 */
export class AuthenticatableRecord extends recordOf(
	blueprintOf((ctx) => ({ email: ctx.email, password: ctx.password })),
	{ unique: ["email"], change: ["password"] },
) {
	/** Whether `plain` is the password the stored hash was made from. */
	verifyPassword(plain: string): Promise<boolean> {
		return new Password(this.password).verify(plain);
	}
}

/** A unique `email` and a sensitive `password`, with `change.password` and `verifyPassword`. */
export const Authenticatable = recordPluginOf(
	"authenticatable",
	AuthenticatableRecord,
	{
		description:
			"A unique email and a sensitive password hash, with change.password and verifyPassword.",
	},
);

/**
 * The standard plugins, by name, for `options.plugins` to pick from, as
 * `(ctx) => [ctx.publishable, ctx.taggable]`, and to resolve their
 * descriptors.
 */
export const StdRecordPlugins = recordPluginCatalogOf(
	Publishable,
	Archivable,
	Taggable,
	Ownable,
	Authenticatable,
);
