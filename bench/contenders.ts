// One adapter per library: it turns a built schema into a contender, a function
// from the input to the library's own result plus `ok`, which tells whether
// that result is a success. Every scenario uses these, so a library is called
// the same way everywhere. To contest how a library is called, change it here.
import { type } from "arktype";
import * as S from "effect/Schema";
import type { Schema as JoiSchema } from "joi";
import * as v from "valibot";
import type { Schema as YupSchema } from "yup";
import type { z } from "zod";

export type Contender = {
	name: string;
	/** Key of the library in `LIBRARIES`, for its version and the summary. */
	library: string;
	note?: string;
	/** Receives the scenario input, returns the library's result. */
	make: (input: unknown) => unknown;
	/** Whether `make`'s result is a success. */
	ok: (result: unknown) => boolean;
	/**
	 * The library only checks: it has no transforms, so in a scenario with
	 * transforms its valid input is the already-clean value.
	 */
	checksOnly?: boolean;
};

export type Scenario = {
	id: string;
	title: string;
	/** One line that describes the shape, for RESULTS.md. */
	shape: string;
	/** Whether the shape trims or lowercases; `false` when valid === validClean. */
	transforms: boolean;
	input: {
		/** Raw: carries the whitespace and the casing the transforms remove. */
		valid: unknown;
		/** The same value already clean, for the libraries that only check. */
		validClean: unknown;
		/** Breaks several rules at once, in different places. */
		invalid: unknown;
	};
	contenders: Contender[];
};

/** npm package of each library, to read the installed version from. */
export const LIBRARIES: Record<string, { label: string; package: string }> = {
	afora: { label: "afora", package: "@afora/core" },
	typebox: { label: "TypeBox", package: "typebox" },
	ajv: { label: "Ajv", package: "ajv" },
	typia: { label: "Typia", package: "typia" },
	zod: { label: "Zod", package: "zod" },
	valibot: { label: "Valibot", package: "valibot" },
	arktype: { label: "ArkType", package: "arktype" },
	effect: { label: "Effect Schema", package: "effect" },
	yup: { label: "Yup", package: "yup" },
	joi: { label: "Joi", package: "joi" },
};

export const typebox = (compiled: {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<unknown>;
}): Contender => ({
	name: "TypeBox compiled (Check, then Errors on failure)",
	library: "typebox",
	checksOnly: true,
	make: (input) => (compiled.Check(input) ? true : [...compiled.Errors(input)]),
	ok: (result) => result === true,
});

/** `validate` comes from an Ajv made with `allErrors: true`, so it collects every error. */
export const ajv = (
	validate: ((value: unknown) => boolean) & { errors?: unknown },
): Contender => ({
	name: "Ajv compiled (allErrors)",
	library: "ajv",
	checksOnly: true,
	make: (input) => (validate(input) ? true : validate.errors),
	ok: (result) => result === true,
});

/** `validate` is generated at build time by `typia.createValidateEquals<T>()`. */
export const typia = (
	validate: (value: unknown) => { success: boolean },
): Contender => ({
	name: "Typia validateEquals (generated at build time)",
	library: "typia",
	checksOnly: true,
	make: (input) => validate(input),
	ok: (result) => (result as { success: boolean }).success,
});

export const zod = (schema: z.ZodType): Contender => ({
	name: "Zod 4 safeParse",
	library: "zod",
	make: (input) => schema.safeParse(input),
	ok: (result) => (result as { success: boolean }).success,
});

export const valibot = (schema: v.GenericSchema): Contender => ({
	name: "Valibot safeParse",
	library: "valibot",
	make: (input) => v.safeParse(schema, input),
	ok: (result) => (result as { success: boolean }).success,
});

export const arktype = (schema: (input: unknown) => unknown): Contender => ({
	name: "ArkType",
	library: "arktype",
	make: schema,
	ok: (result) => !(result instanceof type.errors),
});

const EFFECT_OPTIONS = { errors: "all", onExcessProperty: "error" } as const;

// biome-ignore lint/suspicious/noExplicitAny: any Effect schema without services
export const effect = (schema: S.Codec<any, any, never, never>): Contender => {
	const decode = S.decodeUnknownResult(schema);
	return {
		name: "Effect Schema decodeUnknownResult",
		library: "effect",
		make: (input) => decode(input, EFFECT_OPTIONS),
		ok: (result) => (result as { _tag: string })._tag === "Success",
	};
};

const YUP_OPTIONS = { abortEarly: false } as const;

/** Yup's synchronous API throws on invalid input, so it is timed inside `try/catch`. */
export const yup = (schema: YupSchema): Contender => ({
	name: "Yup validateSync (abortEarly: false)",
	library: "yup",
	make: (input) => {
		try {
			return { value: schema.validateSync(input, YUP_OPTIONS) };
		} catch (error) {
			return { error };
		}
	},
	ok: (result) => !(result as { error?: unknown }).error,
});

const JOI_OPTIONS = { abortEarly: false } as const;

export const joi = (schema: JoiSchema): Contender => ({
	name: "Joi validate (abortEarly: false)",
	library: "joi",
	make: (input) => schema.validate(input, JOI_OPTIONS),
	ok: (result) => !(result as { error?: unknown }).error,
});

const noIssues = (result: unknown) =>
	(result as { issues?: unknown }).issues === undefined;

/**
 * The rows of afora for one blueprint: the blueprint itself, its Standard
 * Schema, and what an application declares from it (a record class, a class
 * of its own, an entity).
 */
export function afora(
	// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
	module: any,
	// biome-ignore lint/suspicious/noExplicitAny: any blueprint
	blueprint: any,
): Contender[] {
	const { entityOf, recordOf } = module;
	const Record = recordOf(blueprint);
	class Sub extends recordOf(blueprint) {}
	class Entity extends entityOf(blueprint) {}
	const standard = blueprint["~standard"];
	return [
		{
			name: "afora blueprint.safeParse",
			library: "afora",
			make: (input) => blueprint.safeParse(input),
			ok: noIssues,
		},
		{
			name: 'afora blueprint["~standard"].validate',
			library: "afora",
			make: (input) => standard.validate(input),
			ok: noIssues,
		},
		{
			name: "afora Record.safeParse",
			library: "afora",
			note: "also creates the instance",
			make: (input) => Record.safeParse(input),
			ok: noIssues,
		},
		{
			name: "afora Subclass.safeParse",
			library: "afora",
			note: "class extends recordOf(...) {}",
			make: (input) => Sub.safeParse(input),
			ok: noIssues,
		},
		{
			name: "afora Entity.safeParse",
			library: "afora",
			note: "class extends entityOf(...) {}, makes its id and createdAt",
			make: (input) => Entity.safeParse(input),
			ok: noIssues,
		},
		{
			name: "afora new Record(value) (in try/catch)",
			library: "afora",
			note: "throws on invalid input",
			make: (input) => {
				try {
					return new Record(input);
				} catch (error) {
					return { error };
				}
			},
			ok: (result) => !(result as { error?: unknown }).error,
		},
	];
}

/** The contender the guard holds to a limit, and the one it is measured against. */
export const GUARDED = "afora blueprint.safeParse";
export const REFERENCE = "Zod 4 safeParse";
/** Timed and shown by the guard, but not held to a limit. */
export const WATCHED = "afora Record.safeParse";

/** Timed by the guard against Zod 4 as well, with the limits of `ENTITY_LIMITS`. */
export const ENTITY = "afora Entity.safeParse";
