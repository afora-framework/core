// Every contender, for the same two shapes, built once. Each contender is a
// function from the input to the library's own result; `ok` tells whether that
// result is a success, so `run.ts` can check each one before timing it.
import { type } from "arktype";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import * as v from "valibot";
import { z } from "zod";

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export async function build(afora: any) {
	const { blueprintOf, entityOf, listOf, propertyOf, recordOf } = afora;

	// ---------------------------------------------------------------- inputs
	// Raw inputs carry the whitespace and the casing the transforms remove.
	const flat = {
		valid: { name: "  Alice  ", email: "  Alice@Example.COM ", age: 30 },
		// The same value already clean, for TypeBox, which has no transforms.
		validClean: { name: "Alice", email: "alice@example.com", age: 30 },
		// Three errors at once: name too short, email malformed, age negative and fractional.
		invalid: { name: "a", email: "not-an-email", age: -1.5 },
	};

	const address = { street: "  Main Street 100 ", zip: "01310-100" };
	const addressClean = { street: "Main Street 100", zip: "01310-100" };
	const nested = {
		valid: {
			...flat.valid,
			address,
			tags: ["coffee", "roast", "bean"],
			addresses: Array.from({ length: 10 }, () => ({ ...address })),
		},
		validClean: {
			...flat.validClean,
			address: addressClean,
			tags: ["coffee", "roast", "bean"],
			addresses: Array.from({ length: 10 }, () => ({ ...addressClean })),
		},
		// Errors in several places: name, email, age, zip (wrong type), six tags
		// (limit is five), and one address of the ten with no street and a short zip.
		invalid: {
			name: "a",
			email: "not-an-email",
			age: -1.5,
			address: { street: "Main Street 100", zip: 1310 },
			tags: ["a", "b", "c", "d", "e", "f"],
			addresses: Array.from({ length: 10 }, (_, index) =>
				index === 3 ? { zip: "1" } : { ...address },
			),
		},
	};

	// ------------------------------------------------------- TypeBox compiled
	const tbAddress = Type.Object(
		{
			street: Type.String({ minLength: 1 }),
			zip: Type.String({ minLength: 5 }),
		},
		{ additionalProperties: false },
	);
	const tbFlat = Type.Object(
		{
			name: Type.String({ minLength: 3 }),
			email: Type.String({ format: "email" }),
			age: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	);
	const tbNested = Type.Object(
		{
			name: Type.String({ minLength: 3 }),
			email: Type.String({ format: "email" }),
			age: Type.Integer({ minimum: 0 }),
			address: tbAddress,
			tags: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
			addresses: Type.Array(tbAddress),
		},
		{ additionalProperties: false },
	);
	const tbFlatC = Compile(tbFlat);
	const tbNestedC = Compile(tbNested);

	// ------------------------------------------------------------------- Zod
	const zName = z.string().trim().min(3);
	// `.email()` is deprecated in v4 but keeps the order: trim, lowercase, then check.
	const zEmail = z.string().trim().toLowerCase().email();
	const zAge = z.number().int().min(0);
	const zAddress = z.strictObject({
		street: z.string().trim().min(1),
		zip: z.string().min(5),
	});
	const zFlat = z.strictObject({ name: zName, email: zEmail, age: zAge });
	const zNested = z.strictObject({
		name: zName,
		email: zEmail,
		age: zAge,
		address: zAddress,
		tags: z.array(z.string().min(1)).max(5),
		addresses: z.array(zAddress),
	});

	// --------------------------------------------------------------- Valibot
	const vName = v.pipe(v.string(), v.trim(), v.minLength(3));
	const vEmail = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email());
	const vAge = v.pipe(v.number(), v.integer(), v.minValue(0));
	const vAddress = v.strictObject({
		street: v.pipe(v.string(), v.trim(), v.minLength(1)),
		zip: v.pipe(v.string(), v.minLength(5)),
	});
	const vFlat = v.strictObject({ name: vName, email: vEmail, age: vAge });
	const vNested = v.strictObject({
		name: vName,
		email: vEmail,
		age: vAge,
		address: vAddress,
		tags: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(5)),
		addresses: v.array(vAddress),
	});

	// --------------------------------------------------------------- ArkType
	const aName = type("string.trim").to("string >= 3");
	const aEmail = type("string.trim")
		.pipe((s: string) => s.toLowerCase())
		.to("string.email");
	const aAge = type("number.integer >= 0");
	const aAddress = type({
		street: type("string.trim").to("string >= 1"),
		zip: "string >= 5",
		"+": "reject",
	});
	const aFlat = type({ name: aName, email: aEmail, age: aAge, "+": "reject" });
	const aNested = type({
		name: aName,
		email: aEmail,
		age: aAge,
		address: aAddress,
		tags: type("string >= 1").array().atMostLength(5),
		addresses: aAddress.array(),
		"+": "reject",
	});

	// --------------------------------------------------------------- afora
	const Name = propertyOf({
		name: "name",
		schema: Type.String({ minLength: 3 }),
		preHandle: (value: string) => value.trim(),
	});
	const Email = propertyOf({
		name: "email",
		schema: Type.String({ format: "email" }),
		preHandle: (value: string) => value.trim().toLowerCase(),
	});
	const Age = propertyOf({
		name: "age",
		schema: Type.Integer({ minimum: 0 }),
	});
	const Street = propertyOf({
		name: "street",
		schema: Type.String({ minLength: 1 }),
		preHandle: (value: string) => value.trim(),
	});
	const Zip = propertyOf({
		name: "zip",
		schema: Type.String({ minLength: 5 }),
	});
	const Tag = propertyOf({
		name: "tag",
		schema: Type.String({ minLength: 1 }),
	});

	const Address = blueprintOf(() => ({ street: Street, zip: Zip }));
	const FlatBlueprint = blueprintOf(() => ({
		name: Name,
		email: Email,
		age: Age,
	}));
	const NestedBlueprint = blueprintOf(() => ({
		name: Name,
		email: Email,
		age: Age,
		address: Address,
		tags: listOf(Tag, { maxItems: 5 }),
		addresses: listOf(Address),
	}));
	const FlatRecord = recordOf(FlatBlueprint);
	const NestedRecord = recordOf(NestedBlueprint);
	// What an application declares: a class of its own, and an entity.
	class FlatSub extends recordOf(FlatBlueprint) {}
	class NestedSub extends recordOf(NestedBlueprint) {}
	class FlatEntity extends entityOf(FlatBlueprint) {}
	class NestedEntity extends entityOf(NestedBlueprint) {}

	const hasStandard = "~standard" in FlatBlueprint;

	type Contender = {
		name: string;
		note?: string;
		/** Receives the scenario input, returns the library's result. */
		make: (input: unknown) => unknown;
		/** Whether `make`'s result is a success. */
		ok: (result: unknown) => boolean;
		/** Input of the valid case, when it differs from the shared one. */
		validInput?: "clean";
		/** Only for the valid case (it throws on the invalid one). */
		validOnly?: boolean;
	};

	const issuesOf = (r: unknown) =>
		(r as { issues?: unknown }).issues === undefined;

	function contenders(
		tb: { Check(v: unknown): boolean; Errors(v: unknown): Iterable<unknown> },
		zs: z.ZodType,
		vs: v.GenericSchema,
		as: (input: unknown) => unknown,
		blueprint: { safeParse(v: unknown): unknown },
		Record: { safeParse(v: unknown): unknown; new (v: never): unknown },
		Sub: { safeParse(v: unknown): unknown },
		Entity: { safeParse(v: unknown): unknown },
	): Contender[] {
		const list: Contender[] = [
			{
				name: "TypeBox compiled (Check, then Errors on failure)",
				note: "no transforms",
				validInput: "clean",
				make: (input) => (tb.Check(input) ? true : [...tb.Errors(input)]),
				ok: (r) => r === true,
			},
			{
				name: "Zod 4 safeParse",
				make: (input) => zs.safeParse(input),
				ok: (r) => (r as { success: boolean }).success,
			},
			{
				name: "Valibot safeParse",
				make: (input) => v.safeParse(vs, input),
				ok: (r) => (r as { success: boolean }).success,
			},
			{
				name: "ArkType",
				make: as,
				ok: (r) => !(r instanceof type.errors),
			},
			{
				name: "afora blueprint.safeParse",
				make: (input) => blueprint.safeParse(input),
				ok: issuesOf,
			},
			{
				name: "afora Record.safeParse",
				make: (input) => Record.safeParse(input),
				ok: issuesOf,
			},
			{
				name: "afora Subclass.safeParse",
				note: "class extends recordOf(...) {}",
				make: (input) => Sub.safeParse(input),
				ok: issuesOf,
			},
			{
				name: "afora Entity.safeParse",
				note: "class extends entityOf(...) {}, makes its id and createdAt",
				make: (input) => Entity.safeParse(input),
				ok: issuesOf,
			},
			{
				name: "afora new Record(value) (in try/catch)",
				note: "throws on invalid input",
				make: (input) => {
					try {
						return new Record(input as never);
					} catch (error) {
						return { error };
					}
				},
				ok: (r) => !(r as { error?: unknown }).error,
			},
		];
		if (hasStandard) {
			list.push({
				name: 'afora blueprint["~standard"].validate',
				make: (input) =>
					(
						blueprint as unknown as {
							"~standard": { validate(v: unknown): unknown };
						}
					)["~standard"].validate(input),
				ok: issuesOf,
			});
		}
		return list;
	}

	return {
		hasStandard,
		scenarios: [
			{
				id: "flat",
				title: "Small flat object",
				input: flat,
				contenders: contenders(
					tbFlatC,
					zFlat,
					vFlat,
					aFlat,
					FlatBlueprint,
					FlatRecord,
					FlatSub,
					FlatEntity,
				),
			},
			{
				id: "nested",
				title: "Nested user (address, 5 tags max, 10 addresses)",
				input: nested,
				contenders: contenders(
					tbNestedC,
					zNested,
					vNested,
					aNested,
					NestedBlueprint,
					NestedRecord,
					NestedSub,
					NestedEntity,
				),
			},
		],
	};
}
