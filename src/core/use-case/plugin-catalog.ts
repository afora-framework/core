import { isVersion, satisfies } from "../record/plugin";
import { Kind } from "../symbols/kind";
import {
	IncompatibleUseCasePlugin,
	InvalidUseCasePlugin,
	UnknownUseCasePlugin,
} from "./exceptions";
import { isUseCasePlugin } from "./plugin";
import type {
	AnyUseCasePlugin,
	IUseCaseCatalog,
	UseCaseContextOf,
	UseCasePluginsByName,
} from "./types/plugin.interface";

/** Whether `value` is a catalog made by `useCaseCatalogOf`. */
export function isUseCaseCatalog(value: unknown): value is IUseCaseCatalog {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "use-case-catalog"
	);
}

/**
 * A catalog of use case `plugins`, by name: what `commandBuilderOf` gives
 * the `useCases` of a command to pick from, as
 * `(ctx) => ({ create: ctx.create(Posts) })`; `catalog.context` is that
 * `ctx`, for use outside a command. Throws `InvalidUseCasePlugin` for what
 * is not a plugin and for two plugins with the same name.
 */
export function useCaseCatalogOf<
	const Plugins extends readonly AnyUseCasePlugin[],
>(...plugins: Plugins): IUseCaseCatalog<UseCasePluginsByName<Plugins>> {
	const byName: Record<string, AnyUseCasePlugin> = {};
	const context: Record<string, unknown> = {};
	for (const plugin of plugins) {
		if (!isUseCasePlugin(plugin)) {
			throw new InvalidUseCasePlugin({
				source: "catalog",
				details: {
					reason: "a catalog takes plugins made by `useCasePluginOf`",
				},
			});
		}
		if (Object.hasOwn(byName, plugin.name)) {
			throw new InvalidUseCasePlugin({
				source: plugin.name,
				details: { reason: "the catalog has another plugin with its name" },
			});
		}
		byName[plugin.name] = plugin;
		context[plugin.name] = plugin.make;
	}

	const find = (name: string): AnyUseCasePlugin => {
		const plugin = Object.hasOwn(byName, name) ? byName[name] : undefined;
		if (!plugin) {
			throw new UnknownUseCasePlugin({ source: "catalog", details: { name } });
		}
		return plugin;
	};

	return Object.freeze({
		[Kind]: "use-case-catalog" as const,
		plugins: Object.freeze(byName) as UseCasePluginsByName<Plugins>,
		list: Object.freeze([...plugins]),
		context: Object.freeze(context) as UseCaseContextOf<
			UseCasePluginsByName<Plugins>
		>,
		resolve(reference: string): AnyUseCasePlugin {
			const at =
				typeof reference === "string" ? reference.lastIndexOf("@") : -1;
			if (at <= 0) return find(String(reference));
			const plugin = find(reference.slice(0, at));
			const version = reference.slice(at + 1);
			if (!isVersion(version)) {
				throw new IncompatibleUseCasePlugin({
					source: plugin.name,
					details: { reason: `"${version}" is not a semantic version` },
				});
			}
			if (!satisfies(plugin.version, version)) {
				throw new IncompatibleUseCasePlugin({
					source: plugin.name,
					details: {
						reason: `version ${plugin.version} does not satisfy ${version}`,
					},
				});
			}
			return plugin;
		},
	});
}
