import type { ListBounds } from "./types";

const SHORTHAND = /^([A-Za-z][A-Za-z0-9]*)(\[\])?(\?)?$/;

/** A field shorthand taken apart: `"User[]?"` is `{ type: "User", list: true, optional: true }`. */
export interface ParsedShorthand {
	readonly type: string;
	readonly list: boolean;
	readonly optional: boolean;
}

/** Takes `"email"`, `"Age?"`, `"string[]"` or `"User[]?"` apart; `undefined` when it is none of them. */
export function parseShorthand(text: string): ParsedShorthand | undefined {
	const match = SHORTHAND.exec(text);
	if (!match) return undefined;
	return {
		type: match[1] as string,
		list: match[2] !== undefined,
		optional: match[3] !== undefined,
	};
}

/** The bounds of a `list` modifier, `undefined` when the field is not a list. */
export function boundsOf(list: unknown): ListBounds | undefined {
	if (list === true) return {};
	if (typeof list === "object" && list !== null && !Array.isArray(list)) {
		return list as ListBounds;
	}
	return undefined;
}

/** Whether `text` is the name of a declaration: PascalCase. */
export function isDeclarationName(text: string): boolean {
	return /^[A-Z][A-Za-z0-9]*$/.test(text);
}

/** Whether `key` can be written unquoted as the key of an object. */
export function isIdentifier(key: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
