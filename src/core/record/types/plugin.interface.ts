import type {
	AnyRecordClass,
	IBlueprint,
	IBlueprintCollection,
} from "../../blueprint/types/blueprint.interface";
import type { Kind } from "../../symbols/kind";
import type { RecordSettings } from "./record.interface";

/**
 * Where the type of the keys a record class lists in `options.unique` is
 * kept, for the records and entities its plugin is applied to. Type only: no
 * class holds a value under it.
 */
export declare const RecordUniqueKeys: unique symbol;

/** What `recordPluginOf` takes, after the record class. */
export interface RecordPluginOptions {
	/** A semantic version, e.g. `1.2.0`; `1.0.0` when left out. */
	readonly version?: string;
	/** What the plugin adds, for catalogs and tools. */
	readonly description?: string;
}

/** A plugin a descriptor requires, by name and version. */
export interface RecordPluginRequirement {
	readonly name: string;
	readonly version: string;
}

/**
 * The plain, JSON form of a plugin, as `plugin.toJSON()` gives it: what a
 * catalog checks to resolve it back to the plugin. Methods are listed by
 * name, never serialized as code.
 */
export interface RecordPluginDescriptor {
	readonly kind: "record-plugin";
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	/** The keys the plugin adds, less those of the plugins it requires. */
	readonly keys: readonly string[];
	readonly sensitive: readonly string[];
	readonly unique: readonly string[];
	readonly change: readonly string[];
	/** The methods and getters the plugin adds. */
	readonly members: readonly string[];
	readonly requires: readonly RecordPluginRequirement[];
}

/**
 * What a catalog resolves to a plugin: its name, its name and a version
 * (`publishable@1.0.0`), or a descriptor.
 */
export type RecordPluginReference = string | RecordPluginDescriptor;

/**
 * Keys, options and behavior taken from a record class, with no identity,
 * that records and entities declare in `options.plugins`; made by
 * `recordPluginOf`.
 */
export interface IRecordPlugin<
	Record extends AnyRecordClass = AnyRecordClass,
	Name extends string = string,
> {
	readonly [Kind]: "record-plugin";
	readonly name: Name;
	readonly version: string;
	readonly description?: string;
	/** The record class the plugin was made from. */
	readonly record: Record;
	/** The keys the plugin adds, less those of the plugins it requires. */
	readonly keys: readonly string[];
	/** The methods and getters it adds, less those of the plugins it requires. */
	readonly members: readonly string[];
	/** The sensitive, unique and `change` keys of its record class. */
	readonly options: RecordSettings<IBlueprintCollection>;
	/** The plugins its record class declares, applied along with it. */
	readonly requires: readonly AnyRecordPlugin[];
	/** Whether `value` is a record or an entity this plugin was applied to. */
	is(value: unknown): value is InstanceType<Record>;
	/** The plugin as a descriptor, as `JSON.stringify` writes it. */
	toJSON(): RecordPluginDescriptor;
}

/** Any plugin, of any record. */
export type AnyRecordPlugin = IRecordPlugin<AnyRecordClass, string>;

/**
 * A named set of plugins: what `options.plugins` picks from, as
 * `(ctx) => [ctx.publishable]`, and what resolves descriptors back to plugins.
 */
export interface IRecordPluginCatalog<
	Plugins extends Readonly<
		globalThis.Record<string, AnyRecordPlugin>
	> = Readonly<globalThis.Record<string, AnyRecordPlugin>>,
> {
	readonly [Kind]: "record-plugin-catalog";
	/** The plugins, by name. */
	readonly plugins: Plugins;
	/** The plugins, in the order they were given. */
	readonly list: readonly AnyRecordPlugin[];
	/**
	 * The plugin `reference` names, checked against it: throws
	 * `UnknownRecordPlugin` when the catalog has no plugin of that name, and
	 * `IncompatibleRecordPlugin` when its version or shape does not satisfy
	 * the descriptor.
	 */
	resolve(reference: RecordPluginReference): AnyRecordPlugin;
	/** `resolve` for each of `references`, e.g. `JSON.parse(JSON.stringify(Post.plugins))`. */
	resolveAll(
		references: readonly RecordPluginReference[],
	): readonly AnyRecordPlugin[];
}

/**
 * The plugins of a catalog made of `Plugins`, by name.
 * @internal
 */
export type RecordPluginsByName<Plugins extends readonly AnyRecordPlugin[]> = {
	readonly [Plugin in Plugins[number] as Plugin["name"]]: Plugin;
};

/**
 * What `options.plugins` picks from: the plugins of every catalog, by name; a
 * later catalog replaces a plugin of an earlier one with the same name.
 * @internal
 */
export type RecordPluginContext<
	Catalogs extends readonly IRecordPluginCatalog[],
> = Catalogs extends readonly [
	infer Head extends IRecordPluginCatalog,
	...infer Tail extends readonly IRecordPluginCatalog[],
]
	? Omit<Head["plugins"], keyof RecordPluginContext<Tail>> &
			RecordPluginContext<Tail>
	: globalThis.Record<never, never>;

/** The plugins of a record or entity: a list, or a function picking them from the context. */
export type RecordPluginsOption<
	Plugins extends readonly AnyRecordPlugin[],
	Context,
> = Plugins | ((ctx: Context) => Plugins);

type UnionToIntersection<Union> = (
	Union extends unknown
		? (value: Union) => void
		: never
) extends (value: infer Intersection) => void
	? Intersection
	: never;

/** The fields of the record class of `Plugin`. */
type PluginProperties<Plugin> = Plugin extends {
	readonly record: {
		readonly blueprint: IBlueprint<infer Properties, boolean>;
	};
}
	? Properties
	: never;

/**
 * The fields of a record, and those of each of its plugins.
 * @internal
 */
export type WithPluginProperties<
	Properties extends IBlueprintCollection,
	Plugins extends readonly AnyRecordPlugin[],
> = [Plugins[number]] extends [never]
	? Properties
	: Properties &
				UnionToIntersection<
					PluginProperties<Plugins[number]>
				> extends infer Merged
		? { readonly [Key in keyof Merged]: Merged[Key] }
		: never;

/** The records of the class of a plugin, with its keys and methods. */
type PluginInstance<Plugin> = Plugin extends {
	readonly record: abstract new (value: never) => infer Instance;
}
	? Instance
	: never;

/**
 * What the plugins add to the records they are applied to: their keys and methods.
 * @internal
 */
export type PluginMembers<Plugins extends readonly AnyRecordPlugin[]> = [
	Plugins[number],
] extends [never]
	? unknown
	: UnionToIntersection<PluginInstance<Plugins[number]>>;

/** The keys the record classes of the plugins list in `options.unique`. */
export type PluginUniqueKey<Plugins extends readonly AnyRecordPlugin[]> =
	Plugins[number] extends infer Plugin
		? Plugin extends {
				readonly record: { readonly [RecordUniqueKeys]?: infer Key };
			}
			? Extract<Key, string>
			: never
		: never;
