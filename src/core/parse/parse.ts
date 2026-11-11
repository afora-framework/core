import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyBlueprintVariant,
	AnyRecordClass,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isBlueprintVariant } from "../blueprint/variant";
import {
	AbstractProperty,
	parsingDefinitionOf,
} from "../property/abstract-property";
import { parserOf, takeRejectionIssues } from "../property/define-property";
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
	/** The collection of each variant of `variant`, by its name; made on its first value. */
	variants: Map<string, Collection> | undefined;
}

/** The fields of a collection of properties, in order: the name and the step of each. */
interface Collection {
	readonly properties: IBlueprintCollection;
	readonly names: readonly string[];
	readonly steps: readonly Step[];
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
}

function runOf(base: Path, source: string): Run {
	return { source, base, keys: [], issues: undefined };
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
 * is parsing it, e.g. a record name.
 */
export function parseCollection(
	properties: IBlueprintCollection,
	value: unknown,
	path: Path,
	source: string,
): ParseResult<Readonly<Record<string, unknown>>> {
	const run = runOf(path, source);
	return resultOf(run, collectionAt(collectionOf(properties), value, run, 0));
}

/** Where a parse that starts at the value itself is: nowhere. Shared, so never changed. */
const ROOT: Path = Object.freeze([]) as unknown as Path;

/**
 * `parseCollection` at the root, as a function of the value alone: what it
 * needs of `properties` is looked up on the first value and kept, instead of
 * on every one. For what parses many values of one shape, a blueprint or a
 * record class. The values of the keys in `vouched` are kept as they are,
 * unchecked: for what the caller made itself and knows to be valid.
 * @internal
 */
export function collectionParserOf(
	properties: IBlueprintCollection,
	source: string,
): (
	value: unknown,
	vouched?: readonly string[],
) => ParseResult<Readonly<Record<string, unknown>>> {
	let collection: Collection | undefined;
	return (value, vouched) => {
		collection ??= collectionOf(properties);
		const run = runOf(ROOT, source);
		return resultOf(run, collectionAt(collection, value, run, 0, vouched));
	};
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
): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return reject(run, "invalid_type", "must be an object", pathOf(run, depth));
	}

	const { properties, names, steps } = collection;
	let rejected = false;

	const keys = Object.keys(value);
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
		tag === undefined ? {} : { [tag]: (value as Record<string, unknown>)[tag] };
	for (let index = 0; index < names.length; index++) {
		const name = names[index] as string;
		if (vouched?.includes(name)) {
			handled[name] = (value as Record<string, unknown>)[name];
			continue;
		}
		run.keys[depth] = name;
		const item = fieldAt(
			steps[index] as Step,
			(value as Record<string, unknown>)[name],
			run,
			depth + 1,
		);
		if (item === REJECTED) rejected = true;
		else if (item !== undefined) handled[name] = item;
	}

	return rejected ? REJECTED : Object.freeze(handled);
}

/**
 * `value` handled by `field`, or every issue found: a property runs its
 * handlers, a blueprint each of its fields, a list each of its items, and a
 * record keeps an instance of its class, and makes one of a plain object.
 * `path` is where `value` is, and `source` who is parsing it.
 */
export function parseField(
	field: BlueprintField | undefined,
	value: unknown,
	path: Path,
	source: string,
): ParseResult<unknown> {
	const run = runOf(path, source);
	return resultOf(run, fieldAt(keptStepOf(field), value, run, 0));
}

/** The `safeParse` of a property that does not declare one. */
const DECLARED_SAFE_PARSE: unknown = AbstractProperty.safeParse;

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
				const handled = fieldAt(item, value[index], run, depth + 1);
				if (handled === REJECTED) rejected = true;
				else items.push(handled);
			}
			return rejected ? REJECTED : Object.freeze(items);
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
				const blueprints: Record<string, AnyBlueprint> = variant.variants;
				for (const tag of Object.keys(blueprints)) {
					variants.set(
						tag,
						collectionOf((blueprints[tag] as AnyBlueprint).properties),
					);
				}
				step.variants = variants;
			}
			const { key } = variant;
			const tag = (value as Record<string, unknown>)[key];
			const collection =
				typeof tag === "string" ? variants.get(tag) : undefined;
			if (collection === undefined) {
				return reject(
					run,
					"invalid_value",
					"must be equal to one of the allowed values",
					[...pathOf(run, depth), key],
				);
			}
			return collectionAt(collection, value, run, depth, undefined, key);
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
			if (handled !== REJECTED) return handled;
			run.issues ??= [];
			takeRejectionIssues(pathOf(run, depth), run.issues);
			return REJECTED;
		}
	}

	const result = property.safeParse(value);
	if (!result.issues) return result.value;

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
