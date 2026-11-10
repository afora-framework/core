import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isProperty } from "../property/is-property";
import { recordNameOf } from "../record/name";
import { movedIssue } from "./issue";
import type { Issue, IssueCode, ParseResult } from "./types/parse.interface";

type Path = readonly (string | number)[];

/** The parent path, when a value has no key of its own under it. */
const NO_KEY = Symbol("no key");

/** The path of the value `key` of `parent`; `parent` itself when there is no key. */
function pathAt(parent: Path, key: string | number | typeof NO_KEY): Path {
	return key === NO_KEY ? parent : [...parent, key];
}

/** A failed result with the one issue that `code` and `message` describe at `path`. */
function rejection(
	code: IssueCode,
	message: string,
	path: Path,
	source: string,
): { readonly issues: readonly Issue[] } {
	return { issues: [{ code, message, path, source }] };
}

/** `result` with the path of each issue it has placed under `path`. */
function underPath<Output>(
	result: ParseResult<Output>,
	path: Path,
): ParseResult<Output> {
	if (!result.issues) return result;
	return {
		issues: result.issues.map((issue) =>
			movedIssue(issue, [...path, ...issue.path]),
		),
	};
}

/**
 * `underPath` for the result of a property, whose issues were made for this
 * parse and are not shared, so they are moved where they are, not copied.
 */
function ownIssuesUnderPath<Output>(
	result: ParseResult<Output>,
	path: Path,
): ParseResult<Output> {
	if (!result.issues) return result;
	if (result.issues.some((issue) => Object.isFrozen(issue))) {
		return underPath(result, path);
	}
	for (const issue of result.issues) {
		(issue as { path: Path }).path = [...path, ...issue.path];
	}
	return result;
}

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
	return collectionAt(properties, value, path, NO_KEY, source);
}

/** `parseCollection` for the value at `key` of `parent`, whose path is made only for an issue. */
function collectionAt(
	properties: IBlueprintCollection,
	value: unknown,
	parent: Path,
	key: string | number | typeof NO_KEY,
	source: string,
): ParseResult<Readonly<Record<string, unknown>>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return rejection(
			"invalid_type",
			"must be an object",
			pathAt(parent, key),
			source,
		);
	}

	let issues: Issue[] | undefined;
	const path = pathAt(parent, key);

	for (const name of Object.keys(value)) {
		if (Object.hasOwn(properties, name)) continue;
		issues ??= [];
		issues.push({
			code: "undeclared_key",
			message: "is not declared",
			path: [...path, name],
			source,
		});
	}

	const handled: Record<string, unknown> = {};
	for (const [name, field] of fieldsOf(properties)) {
		const result = fieldAt(
			field,
			(value as Record<string, unknown>)[name],
			path,
			name,
			source,
		);
		if (result.issues) {
			issues ??= [];
			issues.push(...result.issues);
		} else if (result.value !== undefined) handled[name] = result.value;
	}

	return issues ? { issues } : { value: Object.freeze(handled) };
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
	return fieldAt(field, value, path, NO_KEY, source);
}

/** `parseField` for the value at `key` of `parent`, whose path is made only for an issue. */
function fieldAt(
	field: BlueprintField | undefined,
	value: unknown,
	parent: Path,
	key: string | number | typeof NO_KEY,
	source: string,
): ParseResult<unknown> {
	const required = () =>
		rejection("required", "is required", pathAt(parent, key), source);

	if (isBlueprintList(field)) {
		if (value === undefined) return field.optional ? { value } : required();
		if (!Array.isArray(value)) {
			return rejection(
				"invalid_type",
				"must be an array",
				pathAt(parent, key),
				source,
			);
		}

		const { minItems, maxItems } = field;
		const path = pathAt(parent, key);
		let issues: Issue[] | undefined;
		if (minItems !== undefined && value.length < minItems) {
			issues ??= [];
			issues.push({
				code: "too_few_items",
				message: `must have at least ${minItems} items`,
				path,
				source,
			});
		}
		if (maxItems !== undefined && value.length > maxItems) {
			issues ??= [];
			issues.push({
				code: "too_many_items",
				message: `must have at most ${maxItems} items`,
				path,
				source,
			});
		}

		const items: unknown[] = [];
		for (const [index, item] of value.entries()) {
			const result = fieldAt(field.item, item, path, index, source);
			if (result.issues) {
				issues ??= [];
				issues.push(...result.issues);
			} else items.push(result.value);
		}
		return issues ? { issues } : { value: Object.freeze(items) };
	}

	if (isBlueprint(field)) {
		if (value === undefined) return field.optional ? { value } : required();
		return collectionAt(field.properties, value, parent, key, source);
	}

	const record = recordFieldOf(field);
	if (record) {
		if (value === undefined) return record.optional ? { value } : required();
		if (value instanceof record.record) return { value };
		if (!isPlainObject(value)) {
			return rejection(
				"not_record",
				`must be an instance of record "${recordNameOf(record.record)}"`,
				pathAt(parent, key),
				source,
			);
		}

		const result = record.record.safeParse(value);
		return result.issues ? underPath(result, pathAt(parent, key)) : result;
	}

	if (isProperty(field)) {
		const result = field.safeParse(value);
		return result.issues
			? ownIssuesUnderPath(result, pathAt(parent, key))
			: result;
	}

	return rejection(
		"undeclared_key",
		"is not declared",
		pathAt(parent, key),
		source,
	);
}
