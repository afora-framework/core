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
