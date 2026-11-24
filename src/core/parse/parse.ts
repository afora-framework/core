import { type TSchema, Type } from "typebox";
import Compile from "typebox/compile";
import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyBlueprintVariant,
	AnyRecordClass,
	BlueprintField,
	BlueprintVariants,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isBlueprintVariant } from "../blueprint/variant";
import {
	AbstractProperty,
	parsingDefinitionOf,
} from "../property/abstract-property";
import {
	checkOnlyOf,
	parserOf,
	takeRejectionIssues,
} from "../property/define-property";
import { isProperty } from "../property/is-property";
import type { AnyPropertyConstructor } from "../property/types/property-collection.type";
import { recordNameOf } from "../record/name";
import { movedIssue, REJECTED } from "./issue";
import type { Issue, IssueCode, ParseResult } from "./types/parse.interface";

type Path = readonly (string | number)[];

/** The fields of each collection of properties, as `[key, field]` pairs, made once. */
const entriesOf = new WeakMap<
	IBlueprintCollection,
	readonly (readonly [string, BlueprintField])[]
>();

/**
 * `Object.entries(properties)`, kept for the next time.
 * @internal
 */
export function fieldsOf(
	properties: IBlueprintCollection,
): readonly (readonly [string, BlueprintField])[] {
	let entries = entriesOf.get(properties);
	if (!entries) {
		entries = Object.entries(properties) as [string, BlueprintField][];
		entriesOf.set(properties, entries);
	}
	return entries;
}

/**
 * Whether `value` is an object made by `{}` or `Object.create(null)`, as parsed JSON is.
 * @internal
 */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const OBJECT_PROTOTYPE = Object.prototype as unknown as Record<string, unknown>;
/**
 * An empty array, never written to: reading an index of it gives what a hole
 * of a list would inherit, faster than reading `Array.prototype` itself.
 */
const NO_ITEMS: readonly unknown[] = [];

/**
 * Whether `item`, read from `source[name]`, is only inherited from
 * `Object.prototype`: a key someone added to it (prototype pollution) is not
 * a value of the input, and is treated as absent. A value from another
 * prototype, such as the getter of a class, is the input's own.
 */
function inheritedFromObject(
	source: object,
	name: string,
	item: unknown,
): boolean {
	return item === OBJECT_PROTOTYPE[name] && !Object.hasOwn(source, name);
}

/** An empty object, never written to: what it enumerates, `Object.prototype` has. */
const NO_KEYS: object = {};

/**
 * Whether `Object.prototype` has no enumerable key: nothing was added to it
 * by assignment, as prototype pollution adds keys, so a key an input lacks
 * inherits nothing but its built-in members. Checked once for each object
 * parsed (a `for...in` over an empty object takes about 2 ns), so that each
 * value is only checked when it could be inherited.
 */
function objectPrototypeIsClean(): boolean {
	for (const _key in NO_KEYS) return false;
	return true;
}

/**
 * `source[name]`, or `undefined` when it is only inherited from
 * `Object.prototype`; with `inherits` false, `source[name]` as it is.
 */
function valueAt(
	source: Record<string, unknown>,
	name: string,
	inherits: boolean,
): unknown {
	const item = source[name];
	return inherits &&
		item !== undefined &&
		inheritedFromObject(source, name, item)
		? undefined
		: item;
}

/** `list[index]`, or `undefined` for a hole that `Array.prototype` would fill. */
function itemAt(list: readonly unknown[], index: number): unknown {
	const item = list[index];
	return item !== undefined &&
		item === NO_ITEMS[index] &&
		!Object.hasOwn(list, index)
		? undefined
		: item;
}

/**
 * Writes `item` as the key `name` of `handled`: a key, never the prototype,
 * even for `__proto__` (which a blueprint cannot declare).
 */
function put(handled: Record<string, unknown>, name: string, item: unknown) {
	if (name === "__proto__") {
		Object.defineProperty(handled, name, {
			value: item,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	} else {
		handled[name] = item;
	}
}

/** The values `frozenCopyOf` gave, frozen at every depth: kept as they are. */
const frozenCopies = new WeakSet<object>();

/**
 * How deep a copy goes before it remembers what it copied: only a value with
 * a cycle (which no JSON has) goes deeper, and each object is then copied
 * once, so the copy ends.
 */
const TRACK_AFTER = 32;

/**
 * A copy of the value of a property, frozen at every depth, for a record to
 * keep: the plain objects and arrays in it (as JSON has) are copied, so the
 * caller's own cannot change the record. Other objects, such as a `File`, and
 * primitives are kept as they are.
 */
function frozenCopyOf(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (frozenCopies.has(value)) return value;
	const copy = copyOf(value, 0, undefined);
	if (copy !== value) frozenCopies.add(copy);
	return copy;
}

function copyOf(
	value: object,
	depth: number,
	seen: Map<object, object> | undefined,
): object {
	const isArray = Array.isArray(value);
	if (!isArray && !isPlainObject(value)) return value;
	let copied = seen;
	if (copied === undefined && depth >= TRACK_AFTER) copied = new Map();
	if (copied !== undefined) {
		const done = copied.get(value);
		if (done !== undefined) return done;
	}
	const next = depth + 1;
	if (isArray) {
		const list = value as readonly unknown[];
		const items: unknown[] = [];
		copied?.set(value, items);
		for (let index = 0; index < list.length; index++) {
			const item = list[index];
			items.push(
				typeof item === "object" && item !== null
					? copyOf(item, next, copied)
					: item,
			);
		}
		return Object.freeze(items);
	}
	const source = value as Record<string, unknown>;
	const copy: Record<string, unknown> =
		Object.getPrototypeOf(value) === null ? Object.create(null) : {};
	copied?.set(value, copy);
	for (const name of Object.keys(source)) {
		const item = source[name];
		put(
			copy,
			name,
			typeof item === "object" && item !== null
				? copyOf(item, next, copied)
				: item,
		);
	}
	return Object.freeze(copy);
}

/** What a field is, told once from its brand. */
const PROPERTY = 0;
const LIST = 1;
const BLUEPRINT = 2;
const RECORD = 3;
const UNDECLARED_FIELD = 4;
const VARIANT = 5;
type Kind =
	| typeof PROPERTY
	| typeof LIST
	| typeof BLUEPRINT
	| typeof RECORD
	| typeof UNDECLARED_FIELD
	| typeof VARIANT;

/**
 * How a field handles a value, worked out once: what it is, and what it is
 * made of. Every step has the same members, so that the code reading them
 * always sees one shape.
 */
interface Step {
	readonly kind: Kind;
	readonly property: AnyPropertyConstructor | undefined;
	/**
	 * What the definition `property` parses with does to a value, made on its
	 * first value; `null` when only its `safeParse` can tell.
	 */
	parser: ((value: unknown) => unknown) | null | undefined;
	readonly list: AnyBlueprintList | undefined;
	/** The step of the items of `list`, made on its first item. */
	item: Step | undefined;
	readonly blueprint: AnyBlueprint | undefined;
	/** The steps of the fields of `blueprint`, made on its first value. */
	collection: Collection | undefined;
	readonly record: AnyRecordClass | undefined;
	readonly optionalRecord: boolean;
	readonly variant: AnyBlueprintVariant | undefined;
	/**
	 * Each variant of `variant`, by its name: the collection of a blueprint, or
	 * a record class. Made on its first value.
	 */
	variants: Map<string, Collection | AnyRecordClass> | undefined;
}

/** What a property's definition does to a value: the handled value, or `REJECTED`. */
type Parser = (value: unknown) => unknown;

/** The fields of a collection of properties, in order: the name and the step of each. */
interface Collection {
	readonly properties: IBlueprintCollection;
	readonly names: readonly string[];
	readonly steps: readonly Step[];
	/**
	 * The parser of each field, in order, when every field is a property that
	 * parses through its definition; `null` when one is not. Made on the first
	 * value.
	 */
	parsers: readonly Parser[] | null | undefined;
	/**
	 * One compiled check of a whole value, when every field only checks its
	 * value against a schema; `null` when one does more. Made once the
	 * collection has parsed `COMPILE_AFTER` values, so that a collection
	 * parsed once or twice (a configuration, an environment) does not pay for
	 * compiling it.
	 */
	whole: { Check(value: unknown): boolean } | null | undefined;
	/** How many values the collection parsed before `whole` was made. */
	seen: number;
	/**
	 * Whether a field is named `__proto__`, which no blueprint declares: its
	 * value is then written as a key, by the general path only.
	 */
	readonly guarded: boolean;
	/**
	 * Whether a field has the name of a member of `Object.prototype`, such as
	 * `toString`: an input lacking it inherits that member, so its value is
	 * always checked to be the input's own.
	 */
	readonly inheritable: boolean;
}

/** How many values a collection parses before its whole check is compiled. */
const COMPILE_AFTER = 8;

/**
 * Formats TypeBox checks slowly, or that a schema checks faster on its own
 * (see `formats.ts`): a whole check holding one would be slower, not faster.
 */
const SLOW_FORMATS = new Set([
	"date-time",
	"date",
	"time",
	"duration",
	"uri",
	"uri-reference",
	"uri-template",
	"iri",
	"iri-reference",
	"hostname",
	"idn-hostname",
	"idn-email",
	"regex",
]);

/** Whether `schema` checks a format of `SLOW_FORMATS` anywhere in it. */
function hasSlowFormat(schema: unknown): boolean {
	if (typeof schema !== "object" || schema === null) return false;
	if (Array.isArray(schema)) return schema.some(hasSlowFormat);
	const { format } = schema as { format?: unknown };
	if (typeof format === "string" && SLOW_FORMATS.has(format)) return true;
	return Object.values(schema).some(hasSlowFormat);
}

/**
 * The whole check of `collection`, worked out once: an object of the schemas
 * of its fields, optional where the field is, with no other key. `null` when
 * a field is not a property that only checks its value.
 */
function wholeOf(
	collection: Collection,
): { Check(value: unknown): boolean } | null {
	const fields: Record<string, TSchema> = {};
	for (let index = 0; index < collection.steps.length; index++) {
		const step = collection.steps[index] as Step;
		if (step.kind !== PROPERTY) return null;
		const property = step.property as AnyPropertyConstructor;
		if ((property.safeParse as unknown) !== DECLARED_SAFE_PARSE) return null;
		const check = checkOnlyOf(parsingDefinitionOf(property));
		if (check === undefined || hasSlowFormat(check.schema)) return null;
		const name = collection.names[index] as string;
		fields[name] = check.optional ? Type.Optional(check.schema) : check.schema;
	}
	return Compile(Type.Object(fields, { additionalProperties: false }));
}

/**
 * Whether a collection whose fields are all plain properties is parsed by
 * one loop over their parsers. Turned off only by tests, which compare it
 * with the general path.
 */
let specialized = true;

/**
 * Turns the specialized paths of the parse on or off, and gives what it was.
 * For tests only.
 * @internal
 */
export function setSpecializedParse(on: boolean): boolean {
	const was = specialized;
	specialized = on;
	return was;
}

/** The parser of a step that is a property parsing through its definition, or `null`. */
function plainParserOf(step: Step): Parser | null {
	if (step.kind !== PROPERTY) return null;
	const property = step.property as AnyPropertyConstructor;
	if ((property.safeParse as unknown) !== DECLARED_SAFE_PARSE) return null;
	if (step.parser === undefined) {
		step.parser = parserOf(parsingDefinitionOf(property)) ?? null;
	}
	return step.parser;
}

/** The parsers of `collection`, worked out on its first value. */
function parsersOf(collection: Collection): readonly Parser[] | null {
	let { parsers } = collection;
	if (parsers === undefined) {
		const found: Parser[] = [];
		for (const step of collection.steps) {
			const parser = plainParserOf(step);
			if (parser === null) break;
			found.push(parser);
		}
		parsers = found.length === collection.steps.length ? found : null;
		collection.parsers = parsers;
	}
	return parsers;
}

function stepOf(field: BlueprintField | undefined): Step {
	const record = recordFieldOf(field);
	const kind = isBlueprintList(field)
		? LIST
		: isBlueprint(field)
			? BLUEPRINT
			: isBlueprintVariant(field)
				? VARIANT
				: record
					? RECORD
					: isProperty(field)
						? PROPERTY
						: UNDECLARED_FIELD;

	return {
		kind,
		property: kind === PROPERTY ? (field as AnyPropertyConstructor) : undefined,
		parser: undefined,
		list: kind === LIST ? (field as AnyBlueprintList) : undefined,
		item: undefined,
		blueprint: kind === BLUEPRINT ? (field as AnyBlueprint) : undefined,
		collection: undefined,
		record: kind === RECORD ? record?.record : undefined,
		optionalRecord: kind === RECORD && record?.optional === true,
		variant: kind === VARIANT ? (field as AnyBlueprintVariant) : undefined,
		variants: undefined,
	};
}

/** The step of a field that is not one. */
const UNDECLARED: Step = {
	kind: UNDECLARED_FIELD,
	property: undefined,
	parser: undefined,
	list: undefined,
	item: undefined,
	blueprint: undefined,
	collection: undefined,
	record: undefined,
	optionalRecord: false,
	variant: undefined,
	variants: undefined,
};

/** The step of each field, made once. */
const steps = new WeakMap<object, Step>();

/** `stepOf(field)`, kept for the next time. */
function keptStepOf(field: BlueprintField | undefined): Step {
	if (
		(typeof field !== "object" && typeof field !== "function") ||
		field === null
	) {
		return UNDECLARED;
	}
	let step = steps.get(field);
	if (!step) {
		step = stepOf(field);
		steps.set(field, step);
	}
	return step;
}

/** The collection of each collection of properties, made once. */
const collections = new WeakMap<IBlueprintCollection, Collection>();

function collectionOf(properties: IBlueprintCollection): Collection {
	let collection = collections.get(properties);
	if (!collection) {
		const fields = fieldsOf(properties);
		collection = {
			properties,
			names: fields.map(([name]) => name),
			steps: fields.map(([, field]) => keptStepOf(field)),
			parsers: undefined,
			whole: undefined,
			seen: 0,
			guarded: fields.some(([name]) => name === "__proto__"),
			inheritable: fields.some(([name]) => name in OBJECT_PROTOTYPE),
		};
		collections.set(properties, collection);
	}
	return collection;
}

/**
 * One parse: who is parsing, the issues found so far, and where it is. The
 * key of each value on the way down is written to `keys`, and a path is only
 * made of them for an issue.
 */
interface Run {
	readonly source: string;
	/** The path of the value the parse started at. */
	readonly base: Path;
	/** The keys from that value to the one being handled, by depth. */
	readonly keys: (string | number)[];
	issues: Issue[] | undefined;
	/**
	 * Whether the objects and arrays made are frozen: those a record keeps
	 * are, since they are its state; those handed to the caller are a copy of
	 * its own. Freezing an array takes about 75 ns per item on JavaScriptCore.
	 */
	readonly freeze: boolean;
}

function runOf(base: Path, source: string, freeze: boolean): Run {
	return { source, base, keys: [], issues: undefined, freeze };
}

/** The path of the value `run` is handling at `depth`. */
function pathOf(run: Run, depth: number): (string | number)[] {
	const { base, keys } = run;
	const path: (string | number)[] = base.length === 0 ? [] : [...base];
	for (let index = 0; index < depth; index++) {
		path.push(keys[index] as string | number);
	}
	return path;
}

/** Rejects the value being handled with the one issue `code` and `message` describe at `path`. */
function reject(
	run: Run,
	code: IssueCode,
	message: string,
	path: Path,
): typeof REJECTED {
	run.issues ??= [];
	run.issues.push({ code, message, path, source: run.source });
	return REJECTED;
}

/** What a run made of a value: the value handled, or its issues. */
function resultOf<Output>(run: Run, handled: unknown): ParseResult<Output> {
	return handled === REJECTED
		? { issues: run.issues ?? [] }
		: { value: handled as Output };
}

/**
 * `value` handled by each field of `properties`, or every issue found: each
 * key `properties` does not declare, then those of each field, in order. Keys
 * left `undefined` are dropped. `path` is where `value` is, and `source` who
 * is parsing it, e.g. a record name. With `freeze`, the objects and arrays
 * made are frozen, at every depth.
 */
export function parseCollection(
	properties: IBlueprintCollection,
	value: unknown,
	path: Path,
	source: string,
	freeze = false,
): ParseResult<Readonly<Record<string, unknown>>> {
	const run = runOf(path, source, freeze);
	return resultOf(run, collectionAt(collectionOf(properties), value, run, 0));
}

/** Where a parse that starts at the value itself is: nowhere. Shared, so never changed. */
const ROOT: Path = Object.freeze([]) as unknown as Path;

/**
 * Makes, once the rest of a collection is known to be valid, the values the
 * caller left out for it (`undefined` in `handled`); it returns the keys it
 * made that still have to be checked.
 * @internal
 */
export type Complete = (
	handled: Record<string, unknown>,
) => readonly string[] | undefined;

/**
 * `parseCollection` at the root, as a function of the value alone: what it
 * needs of `properties` is looked up on the first value and kept, instead of
 * on every one. For what parses many values of one shape, a blueprint or a
 * record class. The values of the keys in `vouched` are kept as they are,
 * unchecked: for what the caller made itself and knows to be valid. With
 * `freeze`, the objects and arrays made are frozen, at every depth.
 * @internal
 */
export function collectionParserOf(
	properties: IBlueprintCollection,
	source: string,
	freeze = false,
): (
	value: unknown,
	vouched?: readonly string[],
	complete?: Complete,
) => ParseResult<Readonly<Record<string, unknown>>> {
	let collection: Collection | undefined;
	return (value, vouched, complete) => {
		collection ??= collectionOf(properties);
		const run = runOf(ROOT, source, freeze);
		return resultOf(
			run,
			collectionAt(collection, value, run, 0, vouched, undefined, complete),
		);
	};
}

/**
 * Whether `whole` accepts `value`; `false` when the check throws, as it does
 * for a value too deep for the stack: the paths that take a value it rejects
 * find its issues, and an error is one of them.
 */
function passesWhole(
	whole: { Check(value: unknown): boolean },
	value: unknown,
): boolean {
	try {
		return whole.Check(value);
	} catch {
		return false;
	}
}

/**
 * `parseCollection` for the value `run` is handling at `depth`: the handled
 * value, or `REJECTED` with its issues in `run`. With `tag`, the value is a
 * variant: it also has the key `tag`, which is kept, first, as it is.
 */
function collectionAt(
	collection: Collection,
	value: unknown,
	run: Run,
	depth: number,
	vouched?: readonly string[],
	tag?: string,
	complete?: Complete,
): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return reject(run, "invalid_type", "must be an object", pathOf(run, depth));
	}

	const { properties, names, steps, guarded } = collection;
	let rejected = false;
	// Whether a value read from the input could be inherited, and is checked.
	const inherits = collection.inheritable || !objectPrototypeIsClean();

	// Every field a property that only checks its value, and nothing vouched,
	// completed or tagged: one compiled check of the whole value, which keeps
	// each value as it is. A value it rejects takes the paths below, which
	// find its issues.
	if (
		specialized &&
		!guarded &&
		vouched === undefined &&
		complete === undefined &&
		tag === undefined
	) {
		let { whole } = collection;
		if (whole === undefined && ++collection.seen >= COMPILE_AFTER) {
			whole = wholeOf(collection);
			collection.whole = whole;
		}
		if (whole && isPlainObject(value) && passesWhole(whole, value)) {
			const source = value as Record<string, unknown>;
			const handled: Record<string, unknown> = {};
			let inherited = false;
			for (let index = 0; index < names.length; index++) {
				const name = names[index] as string;
				const item = source[name];
				if (item === undefined) continue;
				// The check read a value `Object.prototype` gave: the paths below
				// treat it as absent.
				if (inherits && inheritedFromObject(source, name, item)) {
					inherited = true;
					break;
				}
				handled[name] =
					run.freeze && typeof item === "object" && item !== null
						? frozenCopyOf(item)
						: item;
			}
			if (!inherited) return run.freeze ? Object.freeze(handled) : handled;
		}
	}

	const keys = Object.keys(value);

	// Every field a plain property, and nothing vouched, completed or tagged:
	// one loop over the parsers, with the path only made for an issue.
	if (
		specialized &&
		!guarded &&
		vouched === undefined &&
		complete === undefined &&
		tag === undefined
	) {
		const parsers = parsersOf(collection);
		if (parsers !== null && declaresEvery(properties, names, keys)) {
			const source = value as Record<string, unknown>;
			const handled: Record<string, unknown> = {};
			for (let index = 0; index < names.length; index++) {
				const name = names[index] as string;
				let own = source[name];
				if (
					inherits &&
					own !== undefined &&
					inheritedFromObject(source, name, own)
				) {
					own = undefined;
				}
				const item = (parsers[index] as Parser)(own);
				if (item === REJECTED) {
					rejected = true;
					run.keys[depth] = name;
					run.issues ??= [];
					takeRejectionIssues(pathOf(run, depth + 1), run.issues);
				} else if (item !== undefined) {
					handled[name] =
						run.freeze && typeof item === "object" && item !== null
							? frozenCopyOf(item)
							: item;
				}
			}
			if (rejected) return REJECTED;
			return run.freeze ? Object.freeze(handled) : handled;
		}
	}

	for (let index = 0; index < keys.length; index++) {
		const name = keys[index] as string;
		// A value written in the order of the blueprint has each key in its place.
		if (
			name === names[index] ||
			name === tag ||
			Object.hasOwn(properties, name)
		) {
			continue;
		}
		rejected = true;
		reject(run, "undeclared_key", "is not declared", [
			...pathOf(run, depth),
			name,
		]);
	}

	// The key of a variant goes first, with the name that chose this collection.
	const handled: Record<string, unknown> =
		tag === undefined
			? {}
			: { [tag]: valueAt(value as Record<string, unknown>, tag, true) };
	// The few keys a caller vouches for (at most three: `id`, `createdAt` and
	// `expiresAt`) are compared as locals, not searched for in each key.
	const first = vouched?.[0];
	const second = vouched?.[1];
	const third = vouched?.[2];
	for (let index = 0; index < names.length; index++) {
		const name = names[index] as string;
		if (
			vouched !== undefined &&
			(name === first ||
				name === second ||
				name === third ||
				(vouched.length > 3 && vouched.includes(name)))
		) {
			const item = valueAt(value as Record<string, unknown>, name, inherits);
			if (guarded) put(handled, name, item);
			else handled[name] = item;
			continue;
		}
		run.keys[depth] = name;
		const item = fieldAt(
			steps[index] as Step,
			valueAt(value as Record<string, unknown>, name, inherits),
			run,
			depth + 1,
		);
		if (item === REJECTED) rejected = true;
		else if (item !== undefined) {
			if (guarded) put(handled, name, item);
			else handled[name] = item;
		}
	}

	if (!rejected && complete !== undefined) {
		for (const name of complete(handled) ?? []) {
			run.keys[depth] = name;
			const item = fieldAt(
				steps[names.indexOf(name)] as Step,
				handled[name],
				run,
				depth + 1,
			);
			if (item === REJECTED) rejected = true;
			else if (item !== undefined) {
				if (guarded) put(handled, name, item);
				else handled[name] = item;
			}
		}
	}

	if (rejected) return REJECTED;
	return run.freeze ? Object.freeze(handled) : handled;
}

/**
 * `value` handled by `field`, or every issue found: a property runs its
 * handlers, a blueprint each of its fields, a list each of its items, and a
 * record keeps an instance of its class, and makes one of a plain object.
 * `path` is where `value` is, and `source` who is parsing it. With `freeze`,
 * the objects and arrays made are frozen, at every depth.
 */
export function parseField(
	field: BlueprintField | undefined,
	value: unknown,
	path: Path,
	source: string,
	freeze = false,
): ParseResult<unknown> {
	const run = runOf(path, source, freeze);
	return resultOf(run, fieldAt(keptStepOf(field), value, run, 0));
}

/** The `safeParse` of a property that does not declare one. */
const DECLARED_SAFE_PARSE: unknown = AbstractProperty.safeParse;

/** Whether every key of `keys` is declared by `properties`, whose fields are `names`. */
function declaresEvery(
	properties: IBlueprintCollection,
	names: readonly string[],
	keys: readonly string[],
): boolean {
	for (let index = 0; index < keys.length; index++) {
		const name = keys[index] as string;
		// A value written in the order of the blueprint has each key in its place.
		if (name !== names[index] && !Object.hasOwn(properties, name)) return false;
	}
	return true;
}

/**
 * `parseField` for the value `run` is handling at `depth`: the handled value,
 * or `REJECTED` with its issues in `run`.
 */
function fieldAt(step: Step, value: unknown, run: Run, depth: number): unknown {
	switch (step.kind) {
		case PROPERTY:
			return propertyAt(step, value, run, depth);

		case LIST: {
			const list = step.list as AnyBlueprintList;
			if (value === undefined) {
				return list.optional ? value : required(run, depth);
			}
			if (!Array.isArray(value)) {
				return reject(
					run,
					"invalid_type",
					"must be an array",
					pathOf(run, depth),
				);
			}

			const { minItems, maxItems } = list;
			let rejected = false;
			if (
				(minItems !== undefined && value.length < minItems) ||
				(maxItems !== undefined && value.length > maxItems)
			) {
				rejected = true;
				const path = pathOf(run, depth);
				if (minItems !== undefined && value.length < minItems) {
					reject(
						run,
						"too_few_items",
						`must have at least ${minItems} items`,
						path,
					);
				}
				if (maxItems !== undefined && value.length > maxItems) {
					reject(
						run,
						"too_many_items",
						`must have at most ${maxItems} items`,
						path,
					);
				}
			}

			step.item ??= keptStepOf(list.item);
			const { item } = step;
			const items: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				run.keys[depth] = index;
				const handled = fieldAt(item, itemAt(value, index), run, depth + 1);
				if (handled === REJECTED) rejected = true;
				else items.push(handled);
			}
			if (rejected) return REJECTED;
			return run.freeze ? Object.freeze(items) : items;
		}

		case BLUEPRINT: {
			const blueprint = step.blueprint as AnyBlueprint;
			if (value === undefined) {
				return blueprint.optional ? value : required(run, depth);
			}
			step.collection ??= collectionOf(blueprint.properties);
			return collectionAt(step.collection, value, run, depth);
		}

		case VARIANT: {
			const variant = step.variant as AnyBlueprintVariant;
			if (value === undefined) {
				return variant.optional ? value : required(run, depth);
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return reject(
					run,
					"invalid_type",
					"must be an object",
					pathOf(run, depth),
				);
			}

			let { variants } = step;
			if (variants === undefined) {
				variants = new Map();
				const declared: BlueprintVariants = variant.variants;
				for (const tag of Object.keys(declared)) {
					const one = declared[tag] as BlueprintVariants[string];
					variants.set(
						tag,
						isBlueprint(one) ? collectionOf(one.properties) : one,
					);
				}
				step.variants = variants;
			}
			// A record of one of its classes is kept, as a record field keeps one.
			if (!isPlainObject(value)) {
				for (const one of variants.values()) {
					if (typeof one === "function" && value instanceof one) return value;
				}
			}
			const { key } = variant;
			const tag = valueAt(value as Record<string, unknown>, key, true);
			const named = typeof tag === "string" ? variants.get(tag) : undefined;
			if (named === undefined) {
				return reject(
					run,
					"invalid_value",
					"must be equal to one of the allowed values",
					[...pathOf(run, depth), key],
				);
			}
			if (typeof named !== "function") {
				return collectionAt(named, value, run, depth, undefined, key);
			}

			// A record class builds its record from the value without the key.
			const { [key]: _name, ...input } = value as Record<string, unknown>;
			const result = named.safeParse(input);
			if (!result.issues) return result.value;
			const path = pathOf(run, depth);
			run.issues ??= [];
			for (const issue of result.issues) {
				run.issues.push(movedIssue(issue, [...path, ...issue.path]));
			}
			return REJECTED;
		}

		case RECORD: {
			const Record = step.record as AnyRecordClass;
			if (value === undefined) {
				return step.optionalRecord ? value : required(run, depth);
			}
			if (value instanceof Record) return value;
			if (!isPlainObject(value)) {
				return reject(
					run,
					"not_record",
					`must be an instance of record "${recordNameOf(Record)}"`,
					pathOf(run, depth),
				);
			}

			const result = Record.safeParse(value);
			if (!result.issues) return result.value;
			const path = pathOf(run, depth);
			run.issues ??= [];
			for (const issue of result.issues) {
				run.issues.push(movedIssue(issue, [...path, ...issue.path]));
			}
			return REJECTED;
		}

		default:
			return reject(
				run,
				"undeclared_key",
				"is not declared",
				pathOf(run, depth),
			);
	}
}

/** Rejects `undefined`, for a field that is not optional. */
function required(run: Run, depth: number): typeof REJECTED {
	return reject(run, "required", "is required", pathOf(run, depth));
}

/** `fieldAt` for a property. */
function propertyAt(
	step: Step,
	value: unknown,
	run: Run,
	depth: number,
): unknown {
	const property = step.property as AnyPropertyConstructor;

	// A property that leaves `safeParse` and the `parse` of its definition as
	// they are is run without the result object they would make.
	if ((property.safeParse as unknown) === DECLARED_SAFE_PARSE) {
		let { parser } = step;
		if (parser === undefined) {
			parser = parserOf(parsingDefinitionOf(property)) ?? null;
			step.parser = parser;
		}
		if (parser !== null) {
			const handled = parser(value);
			if (handled !== REJECTED) {
				return run.freeze && typeof handled === "object" && handled !== null
					? frozenCopyOf(handled)
					: handled;
			}
			run.issues ??= [];
			takeRejectionIssues(pathOf(run, depth), run.issues);
			return REJECTED;
		}
	}

	const result = property.safeParse(value);
	if (!result.issues) {
		const handled: unknown = result.value;
		return run.freeze && typeof handled === "object" && handled !== null
			? frozenCopyOf(handled)
			: handled;
	}

	const path = pathOf(run, depth);
	run.issues ??= [];
	// The issues of a property were made for this parse and are not shared, so
	// they are moved where they are, not copied, unless they cannot be.
	if (result.issues.some((issue) => Object.isFrozen(issue))) {
		for (const issue of result.issues) {
			run.issues.push(movedIssue(issue, [...path, ...issue.path]));
		}
	} else {
		for (const issue of result.issues) {
			(issue as { path: Path }).path = [...path, ...issue.path];
			run.issues.push(issue);
		}
	}
	return REJECTED;
}
