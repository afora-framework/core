import { Kind } from "../symbols/kind";
import {
	IncompatibleRecordPlugin,
	InvalidRecordPlugin,
	UnknownRecordPlugin,
} from "./exceptions";
import { isRecordPlugin, isVersion, satisfies } from "./plugin";
import type {
	AnyRecordPlugin,
	IRecordPluginCatalog,
	RecordPluginDescriptor,
	RecordPluginReference,
	RecordPluginsByName,
} from "./types/plugin.interface";

const LISTS = ["keys", "sensitive", "unique", "change", "members"] as const;

/** Whether `value` is shaped as a descriptor, as `plugin.toJSON()` gives it. */
function isDescriptor(value: unknown): value is RecordPluginDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = value as Partial<Record<string, unknown>>;
	const isList = (list: unknown): boolean =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	return (
		descriptor.kind === "record-plugin" &&
		typeof descriptor.name === "string" &&
		isVersion(descriptor.version) &&
		LISTS.every((list) => isList(descriptor[list])) &&
		Array.isArray(descriptor.requires) &&
		descriptor.requires.every(
			(required: unknown) =>
				typeof required === "object" &&
				required !== null &&
				typeof (required as { name?: unknown }).name === "string" &&
				isVersion((required as { version?: unknown }).version),
		)
	);
}

/** Why `plugin` does not satisfy `descriptor`, or `undefined` when it does. */
function mismatchOf(
	plugin: AnyRecordPlugin,
	descriptor: RecordPluginDescriptor,
): string | undefined {
	if (!satisfies(plugin.version, descriptor.version)) {
		return `version ${plugin.version} does not satisfy ${descriptor.version}`;
	}
	const current: Readonly<Record<(typeof LISTS)[number], readonly string[]>> = {
		keys: plugin.keys,
		sensitive: plugin.options.sensitive,
		unique: plugin.options.unique,
		change: plugin.options.change,
		members: plugin.members,
	};
	for (const list of LISTS) {
		const missing = descriptor[list].find(
			(item) => !current[list].includes(item),
		);
		if (missing !== undefined) return `"${missing}" is not in its ${list}`;
	}
	for (const required of descriptor.requires) {
		const found = plugin.requires.find(({ name }) => name === required.name);
		if (!found) return `it does not require "${required.name}"`;
		if (!satisfies(found.version, required.version)) {
			return `its "${required.name}" ${found.version} does not satisfy ${required.version}`;
		}
	}
	return undefined;
}

/**
 * A catalog of `plugins`, by name: what `recordBuilderOf` and
 * `entityBuilderOf` give `options.plugins` to pick from, as
 * `(ctx) => [ctx.publishable]`, and what resolves the descriptors of
 * `plugin.toJSON()` (e.g. `JSON.stringify(Post.plugins)`) back to plugins.
 * Throws `InvalidRecordPlugin` for two plugins with the same name.
 */
export function recordPluginCatalogOf<
	const Plugins extends readonly AnyRecordPlugin[],
>(...plugins: Plugins): IRecordPluginCatalog<RecordPluginsByName<Plugins>> {
	const byName: Record<string, AnyRecordPlugin> = {};
	for (const plugin of plugins) {
		if (!isRecordPlugin(plugin)) {
			throw new InvalidRecordPlugin({
				source: "catalog",
				details: {
					reason: "a catalog takes plugins made by `recordPluginOf`",
				},
			});
		}
		if (Object.hasOwn(byName, plugin.name)) {
			throw new InvalidRecordPlugin({
				source: plugin.name,
				details: { reason: "the catalog has another plugin with its name" },
			});
		}
		byName[plugin.name] = plugin;
	}

	const find = (name: string): AnyRecordPlugin => {
		const plugin = Object.hasOwn(byName, name) ? byName[name] : undefined;
		if (!plugin) {
			throw new UnknownRecordPlugin({ source: "catalog", details: { name } });
		}
		return plugin;
	};

	const resolve = (reference: RecordPluginReference): AnyRecordPlugin => {
		if (typeof reference === "string") {
			const at = reference.lastIndexOf("@");
			if (at <= 0) return find(reference);
			const plugin = find(reference.slice(0, at));
			const version = reference.slice(at + 1);
			if (!isVersion(version)) {
				throw new IncompatibleRecordPlugin({
					source: plugin.name,
					details: { reason: `"${version}" is not a semantic version` },
				});
			}
			if (!satisfies(plugin.version, version)) {
				throw new IncompatibleRecordPlugin({
					source: plugin.name,
					details: {
						reason: `version ${plugin.version} does not satisfy ${version}`,
					},
				});
			}
			return plugin;
		}
		if (!isDescriptor(reference)) {
			const name = (reference as { name?: unknown } | null)?.name;
			throw new IncompatibleRecordPlugin({
				source: typeof name === "string" ? name : "unknown",
				details: { reason: "it is not a record plugin descriptor" },
			});
		}
		const plugin = find(reference.name);
		const reason = mismatchOf(plugin, reference);
		if (reason !== undefined) {
			throw new IncompatibleRecordPlugin({
				source: plugin.name,
				details: { reason },
			});
		}
		return plugin;
	};

	return Object.freeze({
		[Kind]: "record-plugin-catalog" as const,
		plugins: Object.freeze(byName) as RecordPluginsByName<Plugins>,
		list: Object.freeze([...plugins]),
		resolve,
		resolveAll: (references: readonly RecordPluginReference[]) =>
			Object.freeze(references.map(resolve)),
	});
}
