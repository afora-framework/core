import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import type {
	BlueprintData,
	BlueprintField,
	BlueprintInput,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { parseCollection, parseField } from "../parse/parse";
import type { Issue, ParseResult } from "../parse/types/parse.interface";
import { standardOfClass } from "../standard/standard";
import type { StandardSchemaV1 } from "../standard/standard-schema";
import { Meta } from "../symbols/meta";
import {
	InvalidRecordValue,
	ReservedRecordKey,
	UndeclaredRecordProperty,
} from "./exceptions";
import { maskCollection } from "./mask";
import { recordNameOf } from "./name";
import type {
	IRecord,
	RecordChange,
	RecordEffects,
	RecordSettings,
} from "./types/record.interface";

/** The statics of a class made by `recordOf`, that its records read. */
interface RecordDeclaration<Properties extends IBlueprintCollection> {
	readonly blueprint: IBlueprint<Properties>;
	readonly options: RecordSettings<Properties>;
}

/**
 * The value of each record, kept out of the record itself so that any key of
 * the blueprint can be one of its members.
 */
const values = new WeakMap<object, Readonly<Record<string, unknown>>>();
const metadata = new WeakMap<object, RecordDeclaration<IBlueprintCollection>>();

/**
 * The names of the record's own members, and of those every object inherits
 * (`toString`, `valueOf`, `__proto__`...), which no key of a blueprint can take.
 */
export const RESERVED_RECORD_KEYS: readonly string[] = Object.freeze([
	"onSet",
	"onSetAll",
	"set",
	"toJSON",
	"toString",
	"toLocaleString",
	"valueOf",
	"hasOwnProperty",
	"propertyIsEnumerable",
	"isPrototypeOf",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
	"constructor",
]);

/** Makes each of `keys` a member of the records of `prototype`, e.g. `user.name`. */
export function exposeRecordKeys(
	prototype: object,
	keys: readonly string[],
): void {
	for (const key of keys) {
		Object.defineProperty(prototype, key, {
			get(this: object) {
				return values.get(this)?.[key];
			},
			enumerable: true,
			configurable: true,
		});
	}
}

/** The record classes whose members were checked against their keys. */
const checked = new WeakSet<object>();

/**
 * Throws `ReservedRecordKey` when a class extending a record declares a member
 * with the name of a key, e.g. a `name()` method, which would hide `user.name`.
 * Each class is checked once, on its first record.
 */
function checkMembers(record: object, keys: readonly string[]): void {
	const Class = record.constructor;
	if (checked.has(Class)) return;

	for (
		let prototype = Object.getPrototypeOf(record);
		prototype !== null && !Object.hasOwn(prototype.constructor, "blueprint");
		prototype = Object.getPrototypeOf(prototype)
	) {
		const key = Object.getOwnPropertyNames(prototype).find((name) =>
			keys.includes(name),
		);
		if (key !== undefined) {
			throw new ReservedRecordKey({
				source: recordNameOf(Class),
				details: { key },
			});
		}
	}
	checked.add(Class);
}

/** `details` that also carry `issues`, out of sight when they are logged or compared. */
function withIssues<Details extends object>(
	details: Details,
	issues: readonly Issue[],
): Details & { readonly issues: readonly Issue[] } {
	return Object.defineProperty(details, "issues", {
		value: Object.freeze([...issues]),
		enumerable: false,
	}) as Details & { readonly issues: readonly Issue[] };
}

/**
 * The exception of the first of `issues`, as the record raised it before
 * issues existed, with all of them in its `details`: the exception of a
 * property goes up a layer, an undeclared key is `UndeclaredRecordProperty`,
 * and any other issue is `InvalidRecordValue`.
 */
function exceptionOfIssues(
	issues: readonly Issue[],
	source: string,
): Exception {
	const [first] = issues as readonly [Issue, ...Issue[]];
	const key = first.path.join(".");

	if (first.cause) {
		return first.cause.propagate({
			layer: ExceptionLayers.Record,
			source,
			details: withIssues({ key }, issues),
		});
	}
	if (first.code === "undeclared_key") {
		return new UndeclaredRecordProperty({
			source,
			details: withIssues({ key }, issues),
		});
	}
	return new InvalidRecordValue({
		source,
		details: withIssues({ key, errors: [first.message] }, issues),
	});
}

/** The issues an error thrown by a constructor stands for. */
function issuesOfError(error: unknown, source: string): readonly Issue[] {
	const issues = (error as { details?: { issues?: readonly Issue[] } })?.details
		?.issues;
	if (error instanceof Exception && issues) return issues;

	const cause = Exception.from(error, {
		layer: ExceptionLayers.Record,
		source,
	});
	return [
		{
			code: "invalid_value",
			message: cause.message,
			path: [],
			source,
			cause,
		},
	];
}

/**
 * An instance of `Class`, a class made by `recordOf`, for `value`: `value`
 * itself if it is one already, otherwise what its constructor makes of it, or
 * the issues of the error the constructor throws.
 */
function parseRecord(
	Class: new (value: never) => object,
	value: unknown,
): ParseResult<object> {
	if (value instanceof Class) return { value };
	try {
		return { value: new Class(value as never) };
	} catch (error) {
		return { issues: issuesOfError(error, recordNameOf(Class)) };
	}
}

/** The value of `record`. */
function recordValue<Properties extends IBlueprintCollection>(
	record: AbstractRecord<Properties>,
): Readonly<BlueprintValue<Properties>> {
	return values.get(record) as BlueprintValue<Properties>;
}

/** How `recordDataOf` stores the records a record holds. */
export interface RecordDataOptions {
	/**
	 * Called with each record a record holds, at any depth: a value other than
	 * `undefined` is stored in its place, e.g. its id; `undefined` embeds it.
	 */
	reference?(record: object): unknown;
}

/**
 * The plain value of `record`, unmasked, as a repository stores it: each
 * record it holds, at any depth, as its own plain value, unless
 * `options.reference` stores it as something else. Its record class rebuilds
 * it from that value.
 */
export function recordDataOf(
	record: object,
	options?: RecordDataOptions,
): Readonly<Record<string, unknown>> {
	const { properties } = (record as AbstractRecord<IBlueprintCollection>)[Meta]
		.blueprint;
	return dataOfCollection(
		properties,
		values.get(record) as Readonly<Record<string, unknown>>,
		options,
	);
}

function dataOfCollection(
	properties: IBlueprintCollection,
	value: Readonly<Record<string, unknown>>,
	options: RecordDataOptions | undefined,
): Readonly<Record<string, unknown>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				recordFieldDataOf(properties[key], item, options),
			]),
		),
	);
}

/** `recordDataOf` for a value of `field`, e.g. to look a record up by its plain value. */
export function recordFieldDataOf(
	field: BlueprintField | undefined,
	value: unknown,
	options?: RecordDataOptions,
): unknown {
	if (value === undefined || value === null) return value;
	if (value instanceof AbstractRecord) {
		return options?.reference?.(value) ?? recordDataOf(value, options);
	}
	if (isBlueprintList(field) && Array.isArray(value)) {
		return Object.freeze(
			value.map((item) => recordFieldDataOf(field.item, item, options)),
		);
	}
	if (isBlueprint(field) && typeof value === "object") {
		return dataOfCollection(
			field.properties,
			value as Readonly<Record<string, unknown>>,
			options,
		);
	}
	return value;
}

/**
 * Validates `value` by the field of `key` in the blueprint of `record` and
 * stores it, with no side effect; throws as `set` does. Gives the stored value
 * and the one it replaced.
 */
export function storeRecordValue(
	record: {
		readonly [Meta]: {
			readonly blueprint: { readonly properties: IBlueprintCollection };
		};
	},
	key: string,
	value: unknown,
): { readonly next: unknown; readonly previous: unknown } {
	const source = recordNameOf(record.constructor);
	const { properties } = record[Meta].blueprint;
	if (!Object.hasOwn(properties, key)) {
		throw exceptionOfIssues(
			[
				{
					code: "undeclared_key",
					message: "is not declared",
					path: [key],
					source,
				},
			],
			source,
		);
	}

	const current = values.get(record) as Readonly<Record<string, unknown>>;
	const previous = current[key];
	const result = parseField(properties[key], value, [key], source);
	if (result.issues) throw exceptionOfIssues(result.issues, source);
	const next = result.value;

	const { [key]: _, ...rest } = current;
	values.set(
		record,
		Object.freeze(next === undefined ? rest : { ...rest, [key]: next }),
	);
	return { next, previous };
}

/** The `onSet` and `onSetAll` of the plugins of a record class, by their keys. */
export const RecordPluginHooks = Symbol("recordPluginHooks");

interface PluginHook {
	readonly keys: readonly string[];
	readonly onSet?: () => Readonly<
		Record<string, ((value: unknown, previous: unknown) => void) | undefined>
	>;
	readonly onSetAll?: (change: unknown) => void;
}

/**
 * Runs the `onSetAll` and the effect of `key` in `onSet` of each plugin
 * having `key`, then those of the record, for a stored change.
 */
export function runRecordEffects<Self extends object>(
	record: Self,
	key: PropertyKey,
	next: unknown,
	previous: unknown,
): Self {
	const pluginHooks = (
		record.constructor as {
			readonly [RecordPluginHooks]?: readonly PluginHook[];
		}
	)[RecordPluginHooks];
	if (pluginHooks !== undefined && pluginHooks.length > 0) {
		const name = String(key);
		for (const hook of pluginHooks) {
			if (!hook.keys.includes(name)) continue;
			hook.onSetAll?.call(record, { key, value: next, previous });
			hook.onSet?.call(record)[name]?.call(record, next, previous);
		}
	}

	const hooks = record as unknown as {
		onSetAll(change: unknown): void;
		onSet(): Partial<
			Record<PropertyKey, (value: unknown, previous: unknown) => void>
		>;
	};
	hooks.onSetAll({ key, value: next, previous });
	hooks.onSet()[key]?.(next, previous);
	return record;
}

export abstract class AbstractRecord<Properties extends IBlueprintCollection>
	implements IRecord<Properties>
{
	get [Meta](): RecordDeclaration<Properties> {
		const Class = this.constructor;
		let declaration = metadata.get(Class);
		if (!declaration) {
			const { blueprint, options } =
				Class as unknown as RecordDeclaration<IBlueprintCollection>;
			declaration = Object.freeze({ blueprint, options });
			metadata.set(Class, declaration);
		}
		return declaration as unknown as RecordDeclaration<Properties>;
	}

	constructor(value: BlueprintInput<Properties>) {
		checkMembers(this, Object.keys(this[Meta].blueprint.properties));

		const source = recordNameOf(this.constructor);
		const result = parseCollection(
			this[Meta].blueprint.properties,
			value,
			[],
			source,
		);
		if (result.issues) throw exceptionOfIssues(result.issues, source);
		values.set(this, result.value);
	}

	/**
	 * An instance of the class for `value`, each key handled, or every issue
	 * that rejects it; never throws for an invalid value. A plain object given
	 * for a record field becomes an instance of that record.
	 */
	static safeParse<Self extends new (value: never) => object>(
		this: Self,
		value: unknown,
	): ParseResult<InstanceType<Self>> {
		// biome-ignore lint/complexity/noThisInStatic: the class it is called on, a subclass included
		return parseRecord(this, value) as ParseResult<InstanceType<Self>>;
	}

	/**
	 * The Standard Schema of the class it is read from, a subclass included:
	 * `validate` gives an instance of it, or the issues that reject the value.
	 */
	static get "~standard"(): StandardSchemaV1.Props {
		// biome-ignore lint/complexity/noThisInStatic: the class it is read from, a subclass included
		return standardOfClass(this);
	}

	/**
	 * The value with the sensitive keys, and every property declared
	 * `sensitive` (as `Password`), masked.
	 */
	toJSON(): Readonly<Partial<BlueprintData<Properties>>> {
		return maskCollection(
			this[Meta].blueprint.properties,
			recordValue(this),
			this[Meta].options.sensitive,
		) as Partial<BlueprintData<Properties>>;
	}

	/**
	 * Validates `value`, stores it under `key`, then runs `onSetAll` and the
	 * effect of `key` in `onSet`.
	 */
	protected set<Key extends keyof BlueprintValue<Properties>>(
		key: Key,
		value: BlueprintValue<Properties>[Key],
	): this {
		const { next, previous } = storeRecordValue(this, String(key), value);
		return runRecordEffects(this, key, next, previous);
	}

	/**
	 * The side effect of any change: runs after `set` stores the new value of a
	 * key, before the effect of that key in `onSet`.
	 */
	protected onSetAll(_change: RecordChange<IRecord<Properties>>): void {}

	/**
	 * The side effects of a change, by key: each runs after `set` stores the
	 * new value of its key, and after `onSetAll`, with the value it replaced.
	 */
	protected onSet(): RecordEffects<IRecord<Properties>> {
		return {};
	}
}
