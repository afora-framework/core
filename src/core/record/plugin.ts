import { isRecordClass } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyRecordClass,
} from "../blueprint/types/blueprint.interface";
import { Kind } from "../symbols/kind";
import { RESERVED_RECORD_KEYS } from "./abstract-record";
import { InvalidRecordPlugin, RecordPluginConflict } from "./exceptions";
import type {
	AnyRecordPlugin,
	IRecordPlugin,
	RecordPluginDescriptor,
	RecordPluginOptions,
} from "./types/plugin.interface";

/** The plugins of a record class, those they require included, each once. */
export const RecordPlugins = Symbol("recordPlugins");

/**
 * Set on the classes whose records have identity, as `entityOf`'s, which
 * cannot be plugins.
 */
export const IdentifiedRecord = Symbol("identifiedRecord");

/** A semantic version, e.g. `1.2.0` or `2.0.0-beta.1`. */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `version` is a semantic version. */
export function isVersion(version: unknown): version is string {
	return typeof version === "string" && SEMVER.test(version);
}

/** The major, minor and patch of a semantic version. */
export function versionParts(
	version: string,
): readonly [number, number, number] {
	const [, major, minor, patch] = SEMVER.exec(version) as unknown as [
		string,
		string,
		string,
		string,
	];
	return [Number(major), Number(minor), Number(patch)];
}

/** The members a plugin's record class takes to the records it is applied to. */
const HOOKS = ["onSet", "onSetAll"] as const;

type Hook = (typeof HOOKS)[number];

/** The `onSet` and `onSetAll` a plugin runs, for changes to its `keys`. */
interface RecordPluginHook {
	readonly plugin: AnyRecordPlugin;
	readonly keys: readonly string[];
	readonly onSet?: () => Readonly<
		Record<string, ((value: unknown, previous: unknown) => void) | undefined>
	>;
	readonly onSetAll?: (change: unknown) => void;
}

/** What a plugin keeps out of sight: its members' descriptors and its hooks. */
interface PluginInternals {
	readonly descriptors: Readonly<Record<string, PropertyDescriptor>>;
	readonly hooks: Partial<Record<Hook, (...args: never[]) => unknown>>;
}

const internals = new WeakMap<AnyRecordPlugin, PluginInternals>();

/** The plugins of a record class, or of the class of a record; none for anything else. */
export function pluginsOf(value: unknown): readonly AnyRecordPlugin[] {
	const Class =
		typeof value === "function"
			? value
			: typeof value === "object" && value !== null
				? value.constructor
				: undefined;
	return (
		(Class as { readonly [RecordPlugins]?: readonly AnyRecordPlugin[] })?.[
			RecordPlugins
		] ?? []
	);
}

/** Whether `value` is a plugin made by `recordPluginOf`. */
export function isRecordPlugin(value: unknown): value is AnyRecordPlugin {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "record-plugin"
	);
}

/**
 * Whether `value`, a record, an entity or a class of them, has `plugin`
 * (given or by name), applied to it or required by one of its plugins; a
 * record of the plugin's own class has it too.
 */
export function hasPlugin<Plugin extends AnyRecordPlugin>(
	value: unknown,
	plugin: Plugin,
): value is InstanceType<Plugin["record"]>;
export function hasPlugin(value: unknown, plugin: string): boolean;
export function hasPlugin(
	value: unknown,
	plugin: AnyRecordPlugin | string,
): boolean {
	const plugins = pluginsOf(value);
	if (typeof plugin === "string") {
		return plugins.some((applied) => applied.name === plugin);
	}
	if (plugins.includes(plugin)) return true;
	return typeof value === "function"
		? value === plugin.record || value.prototype instanceof plugin.record
		: value instanceof plugin.record;
}

/**
 * The members the classes between `Record` and the class `recordOf` made
 * declare, by name, and its `onSet` and `onSetAll`; a subclass's member
 * replaces its parent's, as when called.
 */
function membersOf(Record: AnyRecordClass, name: string): PluginInternals {
	const descriptors: Record<string, PropertyDescriptor> = {};
	const hooks: PluginInternals["hooks"] = {};

	for (
		let prototype = Record.prototype as object | null;
		prototype !== null &&
		!Object.hasOwn(
			(prototype as { constructor: object }).constructor,
			"blueprint",
		);
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const member of Object.getOwnPropertyNames(prototype)) {
			if (member === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(
				prototype,
				member,
			) as PropertyDescriptor;
			if ((HOOKS as readonly string[]).includes(member)) {
				hooks[member as Hook] ??= descriptor.value;
				continue;
			}
			if (RESERVED_RECORD_KEYS.includes(member)) {
				throw new InvalidRecordPlugin({
					source: name,
					details: {
						reason: `"${member}" is a member of every record and cannot be replaced`,
					},
				});
			}
			descriptors[member] ??= descriptor;
		}
	}
	return { descriptors: Object.freeze(descriptors), hooks };
}

/**
 * A plugin of the record class `Record`, named `name`: the records and
 * entities that declare it in `options.plugins` get the keys of its
 * blueprint, its sensitive, unique and `change` keys, the methods and getters
 * its class declares, and its `onSet` and `onSetAll` effects, which run for
 * changes to its keys; the plugins of `Record` are applied with it. The
 * constructor of `Record` does not run for them, and its methods cannot use
 * private (`#`) members. E.g.
 * `recordPluginOf("publishable", Publishable, { version: "1.0.0" })`.
 */
export function recordPluginOf<
	Record extends AnyRecordClass,
	const Name extends string,
>(
	name: Name,
	Record: Record,
	{ version = "1.0.0", description }: RecordPluginOptions = {},
): IRecordPlugin<Record, Name> {
	if (typeof name !== "string" || name.length === 0) {
		throw new InvalidRecordPlugin({
			source: String(name),
			details: { reason: "its name must be a non-empty string" },
		});
	}
	if (!isRecordClass(Record)) {
		throw new InvalidRecordPlugin({
			source: name,
			details: { reason: "it must be made from a class of `recordOf`" },
		});
	}
	if ((Record as { readonly [IdentifiedRecord]?: true })[IdentifiedRecord]) {
		throw new InvalidRecordPlugin({
			source: name,
			details: {
				reason:
					"it must be made from a record, not an entity: plugins have no identity",
			},
		});
	}
	if (!isVersion(version)) {
		throw new InvalidRecordPlugin({
			source: name,
			details: { reason: `"${version}" is not a semantic version` },
		});
	}

	const requires = pluginsOf(Record);
	const inherited = new Set(requires.flatMap((required) => required.keys));
	const declaration = Record as unknown as {
		readonly blueprint: AnyBlueprint;
		readonly options: AnyRecordPlugin["options"];
	};
	const keys = Object.freeze(
		Object.keys(declaration.blueprint.properties).filter(
			(key) => !inherited.has(key),
		),
	);
	const own = membersOf(Record, name);

	const plugin: IRecordPlugin<Record, Name> = Object.freeze({
		[Kind]: "record-plugin" as const,
		name,
		version,
		...(description === undefined ? {} : { description }),
		record: Record,
		keys,
		members: Object.freeze(Object.keys(own.descriptors)),
		options: declaration.options,
		requires,
		is: (value: unknown): value is InstanceType<Record> =>
			hasPlugin(value, plugin),
		toJSON: (): RecordPluginDescriptor => descriptorOf(plugin),
	});
	internals.set(plugin, own);
	return plugin;
}

/** The descriptor of `plugin`, as its `toJSON` gives it. */
function descriptorOf(plugin: AnyRecordPlugin): RecordPluginDescriptor {
	return Object.freeze({
		kind: "record-plugin" as const,
		name: plugin.name,
		version: plugin.version,
		...(plugin.description === undefined
			? {}
			: { description: plugin.description }),
		keys: plugin.keys,
		sensitive: plugin.options.sensitive,
		unique: plugin.options.unique,
		change: plugin.options.change,
		members: plugin.members,
		requires: Object.freeze(
			plugin.requires.map(({ name, version }) =>
				Object.freeze({ name, version }),
			),
		),
	});
}

/** What applying plugins to a record gives `declareRecord`. */
export interface AppliedPlugins {
	readonly blueprint: AnyBlueprint;
	readonly plugins: readonly AnyRecordPlugin[];
	readonly sensitive: readonly string[];
	readonly unique: readonly string[];
	readonly change: readonly string[];
	readonly descriptors: Readonly<Record<string, PropertyDescriptor>>;
	readonly hooks: readonly RecordPluginHook[];
}

/**
 * `plugins`, those they require first, applied to `blueprint`, the blueprint
 * of the record `name`: the blueprint joined with theirs, their options, the
 * members to define and the hooks to run. Throws `RecordPluginConflict` when
 * two of them, or one and the record, add the same key or member, or when two
 * different plugins share a name; `reserved` are the members the record has.
 */
export function applyPlugins(
	blueprint: AnyBlueprint,
	plugins: readonly unknown[],
	name: string,
	reserved: readonly string[],
): AppliedPlugins {
	const flat: AnyRecordPlugin[] = [];
	for (const plugin of plugins) {
		if (!isRecordPlugin(plugin)) {
			throw new InvalidRecordPlugin({
				source: name,
				details: {
					reason: "`options.plugins` takes plugins made by `recordPluginOf`",
				},
			});
		}
		for (const applied of [...plugin.requires, plugin]) {
			if (flat.includes(applied)) continue;
			if (flat.some((other) => other.name === applied.name)) {
				throw new RecordPluginConflict({
					source: name,
					details: {
						plugin: applied.name,
						key: applied.name,
						owner: "another plugin",
					},
				});
			}
			flat.push(applied);
		}
	}

	const owners = new Map<string, string>(
		Object.keys(blueprint.properties).map((key) => [key, `record "${name}"`]),
	);
	for (const member of reserved) owners.set(member, `record "${name}"`);
	const claim = (plugin: AnyRecordPlugin, key: string): void => {
		const owner = owners.get(key);
		if (owner !== undefined) {
			throw new RecordPluginConflict({
				source: name,
				details: { plugin: plugin.name, key, owner },
			});
		}
		owners.set(key, `plugin "${plugin.name}"`);
	};

	const descriptors: Record<string, PropertyDescriptor> = {};
	const hooks: RecordPluginHook[] = [];
	for (const plugin of flat) {
		for (const key of plugin.keys) claim(plugin, key);
		const own = internals.get(plugin) as PluginInternals;
		for (const member of plugin.members) {
			claim(plugin, member);
			descriptors[member] = own.descriptors[member] as PropertyDescriptor;
		}
		if (own.hooks.onSet || own.hooks.onSetAll) {
			hooks.push(
				Object.freeze({
					plugin,
					keys: Object.freeze(
						Object.keys(
							(plugin.record as unknown as { blueprint: AnyBlueprint })
								.blueprint.properties,
						),
					),
					...own.hooks,
				}) as RecordPluginHook,
			);
		}
	}

	return {
		blueprint:
			flat.length === 0
				? blueprint
				: blueprint.join(
						...flat.map(
							(plugin) =>
								(plugin.record as unknown as { blueprint: AnyBlueprint })
									.blueprint,
						),
					),
		plugins: Object.freeze(flat),
		sensitive: flat.flatMap((plugin) => plugin.options.sensitive),
		unique: flat.flatMap((plugin) => plugin.options.unique),
		change: flat.flatMap((plugin) => plugin.options.change),
		descriptors,
		hooks: Object.freeze(hooks),
	};
}
