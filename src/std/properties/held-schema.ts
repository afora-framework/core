/**
 * The cost of checking data against a JSON Schema given as a value (held by
 * `SchemaProperty`, or given to `jsonSchemaIssues` and `checkJsonSchema`)
 * is bounded when the schema is accepted, so that a small schema cannot make
 * each check run long or overflow the stack:
 *
 * - a `$ref` is a JSON Pointer into the schema itself (`#`, `#/$defs/a`)
 *   that resolves from its root to a schema, and no chain of `$ref`s comes
 *   back to a schema it went through (a cycle); `$dynamicRef`,
 *   `$recursiveRef` and a `$id` below the root are refused, so every
 *   reference resolves as read here;
 * - the schema, with each use of a `$ref` counted as a copy of what it
 *   refers to, is at most `MAX_SCHEMA_COST` schemas, so that checking a
 *   value takes at most about that many steps at each place in the value;
 * - a `pattern` (and a key of `patternProperties`) is a valid regular
 *   expression without what makes matching take time exponential in the
 *   length of the string: a group repeated (`*`, `+`, `{n,m}`) that holds
 *   a quantifier or an alternation (`(a+)+`, `(a|b)*`), a backreference or
 *   a lookaround, and with at most `MAX_PATTERN_QUANTIFIERS` quantifiers
 *   that vary, so its cost is polynomial in the length, of a low degree.
 */

/**
 * How deep a schema held as a value is read, in JSON levels: a schema nested
 * deeper is rejected, so that checking data against it stays quick and within
 * the stack, on every runtime.
 */
export const MAX_SCHEMA_DEPTH = 128;

/** How many schemas checking a value may go through at each place in it. */
const MAX_SCHEMA_COST = 20_000;

/** How many `$ref`s may be followed one inside the other. */
const MAX_REF_NESTING = 32;

/** How many quantifiers that vary (`*`, `+`, `?`, `{n,m}`) a pattern may have. */
const MAX_PATTERN_QUANTIFIERS = 4;

/** Keys whose value is data, never a schema. */
const DATA_KEYS = new Set(["const", "enum", "default", "examples"]);

/** Keys whose value maps names to schemas. */
const MAP_KEYS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);

/** Keys a JSON Pointer must not go through, as TypeBox reads it. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Path = (string | number)[];

function fail(path: Path, message: string): never {
	throw new Error(
		`${path.length === 0 ? "" : `/${path.join("/")}: `}${message}`,
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Throws for a `$id` below the root, wherever it is: it would change what
 * the `$ref`s under it, or that reach it, resolve to.
 */
function assertNoInnerId(value: unknown, root: boolean, path: Path): void {
	if (typeof value !== "object" || value === null) return;
	if (!root && isObject(value) && typeof value.$id === "string") {
		fail(path, "$id is only taken at the root of the schema");
	}
	for (const key of Object.keys(value)) {
		path.push(key);
		assertNoInnerId((value as Record<string, unknown>)[key], false, path);
		path.pop();
	}
}

/** Whether `text` holds a space or a control character, which a URL drops or changes. */
function hasSpaceOrControl(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

const NOT_A_POINTER = "$ref must be a JSON Pointer into the schema (#/...)";

/** What `ref` refers to in `root`, as TypeBox resolves it. */
function targetOf(root: object, ref: string, path: Path): unknown {
	if (!ref.startsWith("#") || hasSpaceOrControl(ref)) fail(path, NOT_A_POINTER);
	let fragment: string;
	try {
		const url = new URL(ref, "urn:afora:schema");
		if (url.href.endsWith("#")) return root;
		fragment = decodeURIComponent(url.hash.slice(1));
	} catch {
		fail(path, NOT_A_POINTER);
	}
	if (!fragment.startsWith("/")) fail(path, NOT_A_POINTER);
	let current: unknown = root;
	for (const segment of fragment.slice(1).split("/")) {
		const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (
			typeof current !== "object" ||
			current === null ||
			UNSAFE_KEYS.has(key) ||
			!Object.hasOwn(current, key)
		) {
			fail(path, "$ref does not resolve in the schema");
		}
		current = (current as Record<string, unknown>)[key];
	}
	if (!isObject(current) && typeof current !== "boolean") {
		fail(path, "$ref does not resolve to a schema");
	}
	return current;
}

interface Group {
	varies: boolean;
	alternates: boolean;
}

/**
 * Throws when `pattern` is not a valid regular expression (with the `u`
 * flag, as TypeBox reads it) whose matching time is bounded as the module
 * says.
 */
function assertSafePattern(pattern: string, path: Path): void {
	try {
		new RegExp(pattern, "u");
	} catch {
		fail(path, "is not a valid regular expression");
	}
	const unsafe = (why: string): never =>
		fail(path, `is a pattern whose matching can take too long (${why})`);
	const groups: Group[] = [{ varies: false, alternates: false }];
	let quantifiers = 0;
	// What a quantifier would apply to: a group, another atom, or nothing.
	let last: Group | "atom" | undefined;
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] as string;
		const current = groups[groups.length - 1] as Group;
		if (char === "\\") {
			const next = pattern[index + 1] ?? "";
			if ((next >= "1" && next <= "9") || next === "k") {
				unsafe("a backreference");
			}
			if (
				(next === "u" || next === "p" || next === "P") &&
				pattern[index + 2] === "{"
			) {
				index = pattern.indexOf("}", index) + 1;
			} else if (next === "u") index += 6;
			else if (next === "x") index += 4;
			else if (next === "c") index += 3;
			else index += 2;
			last = next === "b" || next === "B" ? undefined : "atom";
			continue;
		}
		if (char === "[") {
			index++;
			if (pattern[index] === "^") index++;
			while (index < pattern.length && pattern[index] !== "]") {
				index += pattern[index] === "\\" ? 2 : 1;
			}
			index++;
			last = "atom";
			continue;
		}
		if (char === "(") {
			index++;
			if (pattern[index] === "?") {
				const rest = pattern.slice(index + 1);
				if (/^(?:=|!|<=|<!)/.test(rest)) unsafe("a lookaround");
				// The name or the flags of the group.
				index = pattern.indexOf(rest.startsWith("<") ? ">" : ":", index) + 1;
			}
			groups.push({ varies: false, alternates: false });
			last = undefined;
			continue;
		}
		if (char === ")") {
			const group = groups.pop() as Group;
			const parent = groups[groups.length - 1] as Group;
			parent.varies ||= group.varies;
			parent.alternates ||= group.alternates;
			index++;
			last = group;
			continue;
		}
		if (char === "|") {
			current.alternates = true;
			index++;
			last = undefined;
			continue;
		}
		let min = -1;
		let max = -1;
		if (char === "*" || char === "+" || char === "?") {
			min = char === "+" ? 1 : 0;
			max = char === "?" ? 1 : Number.POSITIVE_INFINITY;
			index++;
		} else if (char === "{") {
			const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
			if (braces) {
				min = Number(braces[1]);
				max =
					braces[2] === undefined
						? min
						: braces[3] === ""
							? Number.POSITIVE_INFINITY
							: Number(braces[3]);
				index += braces[0].length;
			}
		}
		if (max >= 0) {
			// A lazy quantifier backtracks as much.
			if (pattern[index] === "?") index++;
			if (
				max > 1 &&
				typeof last === "object" &&
				(last.varies || last.alternates)
			) {
				unsafe("a repeated group that holds a quantifier or an alternation");
			}
			if (max !== min) {
				current.varies = true;
				if (++quantifiers > MAX_PATTERN_QUANTIFIERS) {
					unsafe(`more than ${MAX_PATTERN_QUANTIFIERS} quantifiers that vary`);
				}
			}
			last = undefined;
			continue;
		}
		last = char === "^" || char === "$" ? undefined : "atom";
		index++;
	}
}

/**
 * Throws, with the path and the reason, when checking data against
 * `schema` is not bounded as the module says. The depth of `schema` is
 * checked first: it is walked here.
 */
export function assertHeldSchema<Value>(schema: Value): Value {
	if (typeof schema !== "object" || schema === null) return schema;
	const root = schema as object;
	assertNoInnerId(root, true, []);
	// The cost of each schema, once computed; the ones being computed.
	const costs = new Map<object, number>();
	const open = new Set<object>();
	const path: Path = [];

	const add = (total: number, more: number): number => {
		const sum = total + more;
		if (sum > MAX_SCHEMA_COST) fail(path, "expands to too many schemas");
		return sum;
	};

	function costOf(node: unknown, nesting: number): number {
		if (typeof node !== "object" || node === null) return 1;
		const known = costs.get(node);
		if (known !== undefined) return known;
		if (open.has(node)) fail(path, "$ref makes a cycle");
		open.add(node);
		let total = 1;
		if (Array.isArray(node)) {
			for (let index = 0; index < node.length; index++) {
				path.push(index);
				total = add(total, costOf(node[index], nesting));
				path.pop();
			}
		} else {
			const object = node as Record<string, unknown>;
			for (const key of Object.keys(object)) {
				const value = object[key];
				if (DATA_KEYS.has(key)) continue;
				path.push(key);
				if (key === "$ref" && typeof value === "string") {
					if (nesting >= MAX_REF_NESTING) {
						fail(path, "$ref is nested too deeply");
					}
					const target = targetOf(root, value, path);
					total = add(total, 1 + costOf(target, nesting + 1));
				} else if (key === "$dynamicRef" || key === "$recursiveRef") {
					fail(path, `${key} is not taken in a schema held as a value`);
				} else if (key === "pattern" && typeof value === "string") {
					assertSafePattern(value, path);
				} else if (MAP_KEYS.has(key) && isObject(value)) {
					for (const name of Object.keys(value)) {
						path.push(name);
						if (key === "patternProperties") assertSafePattern(name, path);
						total = add(total, costOf(value[name], nesting));
						path.pop();
					}
				} else if (typeof value === "object" && value !== null) {
					total = add(total, costOf(value, nesting));
				}
				path.pop();
			}
		}
		open.delete(node);
		costs.set(node, total);
		return total;
	}

	costOf(root, 0);
	return schema;
}
