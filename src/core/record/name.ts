/** What a declared name must be: an identifier, so it can name a table or a schema. */
const RECORD_NAME = /^[A-Za-z_$][\w$]*$/;

/** Whether `name` can be the `name` option of `recordOf` or `entityOf`. */
export function isRecordName(name: unknown): name is string {
	return typeof name === "string" && RECORD_NAME.test(name);
}

/**
 * The name of a record or entity class: the `name` option it, or the class it
 * extends, was declared with, which bundlers and minifiers do not change;
 * without one, the name of the class.
 */
export function recordNameOf(Class: object): string {
	const { recordName, name } = Class as {
		readonly recordName?: unknown;
		readonly name?: unknown;
	};
	return typeof recordName === "string" ? recordName : String(name);
}

/** The classes `recordOf` and `entityOf` made with a `name`, and that name. */
const declaredNames = new WeakMap<object, string>();

/** Keeps the `name` option `Class` was declared with. */
export function declareRecordName(Class: object, name: string): void {
	declaredNames.set(Class, name);
}

/**
 * The name `Class` declares: the `name` option of it or of a class it
 * extends, or a `static recordName` of its own; `undefined` when the name of
 * the record is only the name of its class.
 */
export function declaredRecordNameOf(Class: object): string | undefined {
	for (
		let current: unknown = Class;
		typeof current === "function";
		current = Object.getPrototypeOf(current)
	) {
		const own = Object.getOwnPropertyDescriptor(current, "recordName")?.value;
		if (typeof own === "string") return own;
		const declared = declaredNames.get(current);
		if (declared !== undefined) return declared;
	}
	return undefined;
}
