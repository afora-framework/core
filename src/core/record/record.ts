import type {
	AnyBlueprint,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { Kind } from "../symbols/kind";
import {
	AbstractRecord,
	exposeRecordKeys,
	RESERVED_RECORD_KEYS,
	RecordPluginHooks,
} from "./abstract-record";
import {
	InvalidRecordDeclaration,
	RecordPluginConflict,
	ReservedRecordKey,
	UndeclaredRecordProperty,
} from "./exceptions";
import { isMarked } from "./marks";
import { isRecordName } from "./name";
import { applyPlugins, RecordPlugins } from "./plugin";
import type {
	AnyRecordPlugin,
	IRecordPluginCatalog,
	PluginMembers,
	PluginSensitiveKey,
	PluginUniqueKey,
	RecordPluginContext,
	WithPluginProperties,
} from "./types/plugin.interface";
import type {
	RecordConstructor,
	RecordKey,
	RecordOptions,
	RecordSettings,
} from "./types/record.interface";

/**
 * What `recordBuilderOf` returns: `recordOf`, whose `options.plugins` can
 * pick plugins from `Context`, the plugins of its catalogs by name.
 */
export type RecordBuilder<Context> = <
	Properties extends IBlueprintCollection,
	const Change extends readonly RecordKey<Properties>[] = [],
	const Unique extends readonly RecordKey<Properties>[] = [],
	const Plugins extends readonly AnyRecordPlugin[] = [],
	const Sensitive extends readonly RecordKey<Properties>[] = [],
>(
	blueprint: IBlueprint<Properties, boolean>,
	options?: RecordOptions<
		NoInfer<Properties>,
		Change,
		Unique,
		Plugins,
		Context,
		Sensitive
	>,
) => RecordConstructor<
	WithPluginProperties<Properties, Plugins>,
	Change,
	Unique[number] | PluginUniqueKey<Plugins>,
	PluginMembers<Plugins>,
	never,
	Sensitive[number] | PluginSensitiveKey<Plugins>
>;

/**
 * A `recordOf` whose `options.plugins` can pick plugins from `catalogs`,
 * e.g. `recordBuilderOf(StdRecordPlugins)`, as `(ctx) => [ctx.publishable]`;
 * a later catalog replaces a plugin of an earlier one with the same name.
 */
export function recordBuilderOf<
	const Catalogs extends readonly IRecordPluginCatalog[],
>(...catalogs: Catalogs): RecordBuilder<RecordPluginContext<Catalogs>> {
	const context = pluginContextOf(catalogs);
	return ((blueprint: AnyBlueprint, options: RecordOptionsInput = {}) =>
		declareRecord(
			AbstractRecord,
			blueprint,
			options,
			"record",
			[],
			context,
		)) as unknown as RecordBuilder<RecordPluginContext<Catalogs>>;
}

/** The plugins of `catalogs`, by name, for `options.plugins` to pick from. */
export function pluginContextOf(
	catalogs: readonly IRecordPluginCatalog[],
): Readonly<Record<string, AnyRecordPlugin>> {
	return Object.freeze(
		Object.assign({}, ...catalogs.map((catalog) => catalog.plugins)),
	);
}

/**
 * A record of `blueprint`: built from a value of the blueprint's shape, e.g.
 * `new User({ name: "Jane" })`, with each key as a member (`user.name`), and
 * changed by the protected `set`, or by `change.<key>(value)` for the keys
 * in `options.change`. Extend it to declare the side effects of a change in
 * `onSetAll` and `onSet`. The class can be a field of another blueprint, e.g.
 * `{ author: User }`, whose records then take an instance of it. Plugins in
 * `options.plugins` add their keys, options and methods to it.
 */
export const recordOf: RecordBuilder<Record<never, never>> = recordBuilderOf();

/** The options `declareRecord` takes, untyped. */
interface RecordOptionsInput {
	readonly name?: string;
	readonly sensitive?: readonly string[];
	readonly unique?: readonly string[];
	readonly change?: readonly string[];
	readonly plugins?:
		| readonly unknown[]
		| ((ctx: Readonly<Record<string, AnyRecordPlugin>>) => readonly unknown[]);
}

/**
 * The class `recordOf` makes, extending `Base` instead of `AbstractRecord`,
 * and named `name`; `reserved` are more names no key can take, the members
 * `Base` adds, and `context` the plugins `options.plugins` can pick from.
 */
export function declareRecord(
	Base: abstract new (value: never) => AbstractRecord<IBlueprintCollection>,
	declared: AnyBlueprint,
	{ plugins = [], name: declaredName, ...declaredOptions }: RecordOptionsInput,
	fallback: string,
	reserved: readonly string[] = [],
	context: Readonly<Record<string, AnyRecordPlugin>> = {},
): abstract new (
	value: never,
) => AbstractRecord<IBlueprintCollection> {
	if (declaredName !== undefined && !isRecordName(declaredName)) {
		throw new InvalidRecordDeclaration({
			source: fallback,
			details: `"name" must be an identifier, got ${JSON.stringify(declaredName)}.`,
		});
	}
	const name = declaredName ?? fallback;
	const applied = applyPlugins(
		declared,
		typeof plugins === "function" ? plugins(context) : plugins,
		name,
		reserved,
	);
	const blueprint = applied.blueprint;
	const sensitive = [
		...(declaredOptions.sensitive ?? []),
		...applied.sensitive,
	];
	const unique = [...(declaredOptions.unique ?? []), ...applied.unique];
	const declaredChange = declaredOptions.change ?? [];
	const keys = Object.keys(blueprint.properties);
	const change = keys.filter(
		(key) => declaredChange.includes(key) || applied.change.includes(key),
	);
	for (const key of [...sensitive, ...unique, ...declaredChange]) {
		if (!keys.includes(key)) {
			throw new UndeclaredRecordProperty({
				source: name,
				details: { key },
			});
		}
	}

	const methods = change.length > 0 ? [CHANGE_MEMBER] : [];
	for (const member of Object.keys(applied.descriptors)) {
		if (methods.includes(member)) {
			const plugin = applied.plugins.find((plugin) =>
				plugin.members.includes(member),
			) as AnyRecordPlugin;
			throw new RecordPluginConflict({
				source: name,
				details: {
					plugin: plugin.name,
					key: member,
					owner: `record "${name}" (the \`change\` namespace)`,
				},
			});
		}
	}
	for (const key of keys) {
		if (
			RESERVED_RECORD_KEYS.includes(key) ||
			reserved.includes(key) ||
			methods.includes(key)
		) {
			throw new ReservedRecordKey({ source: name, details: { key } });
		}
	}

	const options: RecordSettings<IBlueprintCollection> = Object.freeze({
		sensitive: Object.freeze(
			keys.filter(
				(key) =>
					sensitive.includes(key) ||
					isMarked(blueprint.properties[key], "sensitive", { lists: true }),
			),
		),
		unique: Object.freeze(
			keys.filter(
				(key) =>
					unique.includes(key) || isMarked(blueprint.properties[key], "unique"),
			),
		),
		change: Object.freeze([...change]),
	});

	class DeclaredRecord extends Base {
		static readonly [Kind] = "record" as const;
		static readonly blueprint = blueprint as IBlueprint<IBlueprintCollection>;
		static readonly options = options;
		static readonly plugins = applied.plugins;
		static readonly [RecordPlugins] = applied.plugins;
		static readonly [RecordPluginHooks] = applied.hooks;
	}

	// The declared `name`; without one, the name of the class it is read on,
	// so a subclass answers with its own.
	Object.defineProperty(DeclaredRecord, "recordName", {
		get(this: { readonly name: string }) {
			return declaredName ?? this.name;
		},
		configurable: true,
	});

	exposeRecordKeys(DeclaredRecord.prototype, keys);
	for (const [member, descriptor] of Object.entries(applied.descriptors)) {
		Object.defineProperty(DeclaredRecord.prototype, member, descriptor);
	}
	if (change.length > 0) {
		Object.defineProperty(DeclaredRecord.prototype, CHANGE_MEMBER, {
			get(this: { set(key: string, value: unknown): unknown }) {
				let namespace = changeNamespaces.get(this);
				if (namespace === undefined) {
					namespace = Object.freeze(
						Object.fromEntries(
							change.map((key) => [
								key,
								(value: unknown) => this.set(key, value),
							]),
						),
					);
					changeNamespaces.set(this, namespace);
				}
				return namespace;
			},
			configurable: true,
		});
	}

	Object.defineProperty(DeclaredRecord, "name", { value: name });

	return DeclaredRecord;
}

/** The member holding the methods that change the keys of `options.change`: `user.change.name(value)`. */
const CHANGE_MEMBER = "change";

/** The `change` namespace of each record, made on first read and bound to it. */
const changeNamespaces = new WeakMap<object, object>();
