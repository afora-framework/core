// Leaves that several scenarios declare the same way.
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import * as S from "effect/Schema";
import * as T from "effect/SchemaTransformation";
import { Type } from "typebox";

// Both packages are CommonJS: under Node's ESM the class and the function are on `default`.
// biome-ignore lint/suspicious/noExplicitAny: CommonJS interop
const Ajv = ((AjvModule as any).default ?? AjvModule) as typeof AjvModule;
const addFormats = // biome-ignore lint/suspicious/noExplicitAny: CommonJS interop
	((addFormatsModule as any).default ??
		addFormatsModule) as typeof addFormatsModule;

/** One Ajv for every scenario; `allErrors` makes it collect every error, as the others do. */
export const ajvInstance = new Ajv({ allErrors: true, discriminator: true });
addFormats(ajvInstance);

// ---------------------------------------------------------------- Effect
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const eTrimmed = S.String.pipe(S.decodeTo(S.String, T.trim()));

/** A string of at least `min` characters, trimmed first unless `trim` is false. */
export const eText = (min: number, trim = true) =>
	trim
		? eTrimmed.pipe(S.decodeTo(S.String.check(S.isMinLength(min))))
		: S.String.check(S.isMinLength(min));

/** An email, trimmed and lowercased first unless `transform` is false. Effect has no email check of its own. */
export const eEmail = (transform = true) =>
	transform
		? eTrimmed.pipe(
				S.decodeTo(S.String, T.toLowerCase()),
				S.decodeTo(S.String.check(S.isPattern(EMAIL))),
			)
		: S.String.check(S.isPattern(EMAIL));

export const eInt = (min: number) => S.Int.check(S.isGreaterThanOrEqualTo(min));

// ----------------------------------------------------------------- afora
/** Properties of afora, declared with `propertyOf` as an application would. */
// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export function aforaProperties(afora: any) {
	const { propertyOf } = afora;
	return {
		text: (name: string, min: number, trim = true) =>
			propertyOf({
				name,
				schema: Type.String({ minLength: min }),
				...(trim ? { preHandle: (value: string) => value.trim() } : {}),
			}),
		email: (name: string, transform = true) =>
			propertyOf({
				name,
				schema: Type.String({ format: "email" }),
				...(transform
					? { preHandle: (value: string) => value.trim().toLowerCase() }
					: {}),
			}),
		integer: (name: string, min: number) =>
			propertyOf({ name, schema: Type.Integer({ minimum: min }) }),
		// biome-ignore lint/suspicious/noExplicitAny: any TypeBox schema
		of: (name: string, schema: any) => propertyOf({ name, schema }),
	};
}
