// Everything that walks the fields of a blueprint, on a variant field.
import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { diffSchemas, schemaLockOf } from "../../adapters";
import { sliceOf } from "../../experimental";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	listOf,
	propertyOf,
	recordOf,
	stripUndeclared,
	toOpenAPI,
	variantOf,
} from "../../index";
import { InvalidBlueprintVariant } from "./exceptions";

const Secret = propertyOf({
	name: "secret",
	schema: Type.String({ minLength: 1 }),
	sensitive: true,
});
const Card = blueprintOf((ctx) => ({ holder: ctx.text, number: Secret }));
const Pix = blueprintOf((ctx) => ({ key: ctx.text }));
const Method = variantOf("method", { card: Card, pix: Pix });
const Payment = blueprintOf((ctx) => ({
	amount: ctx.integer,
	by: Method,
	tried: ctx.listOf(Method),
}));

const card = { method: "card", holder: "Jane", number: "4111" } as const;
const pix = { method: "pix", key: "jane@example.com" } as const;

test("toJSON masks a sensitive leaf inside a variant, and keeps the key", () => {
	class Paid extends recordOf(Payment) {}
	const paid = new Paid({ amount: 10, by: card, tried: [pix, card] });

	expect(paid.by).toEqual(card);
	expect(paid.toJSON()).toEqual({
		amount: 10,
		by: { method: "card", holder: "Jane", number: "********" },
		tried: [pix, { method: "card", holder: "Jane", number: "********" }],
	});
	// The JSON of each variant is told apart by the key, as its value is.
	const json = paid.toJSON().by;
	if (json.method === "card") expect(json.number).toBe("********");
});

test("a key listed as sensitive masks the whole variant", () => {
	class Hidden extends recordOf(Payment, { sensitive: ["by"] }) {}
	const hidden = new Hidden({ amount: 10, by: pix, tried: [] });

	expect(hidden.toJSON().by).toEqual({ method: "********", key: "********" });
});

test("stripping keeps the key and the keys of the variant it names", () => {
	expect(
		stripUndeclared(Payment, {
			amount: 10,
			extra: 1,
			by: { ...card, extra: 1 },
			tried: [
				{ ...pix, holder: "of a card" },
				{ method: "boleto", x: 1 },
			],
		}),
	).toEqual({
		amount: 10,
		by: card,
		// A value that names no variant is left whole, for parsing to reject.
		tried: [pix, { method: "boleto", x: 1 }],
	});
});

test("an entity stores the plain value of a variant, and its record keeps it", () => {
	class Order extends entityOf(Payment, { name: "Order" }) {}
	const order = new Order({ amount: 10, by: card, tried: [pix] });

	expect(order.by).toEqual(card);
	expect(Object.keys(order.by)).toEqual(["method", "holder", "number"]);
});

describe("describe and the schema lock", () => {
	const appOf = (blueprint: Parameters<typeof entityOf>[0]) =>
		applicationOf({
			name: "app",
			entities: { Order: entityOf(blueprint, { name: "Order" }) },
		} as never);

	test("a variant field is described with its key and each variant", () => {
		const description = appOf(Payment).describe() as unknown as {
			entities: { Order: { fields: Record<string, unknown> } };
		};

		expect(description.entities.Order.fields.by).toMatchObject({
			kind: "variant",
			key: "method",
			optional: false,
			variants: {
				card: { kind: "blueprint", fields: { holder: { kind: "property" } } },
				pix: { kind: "blueprint", fields: { key: { kind: "property" } } },
			},
		});
	});

	test("the lock holds each variant, and the diff tells a change inside one", () => {
		const before = schemaLockOf(appOf(Payment).describe());
		const CardWithExpiry = blueprintOf((ctx) => ({
			holder: ctx.text,
			number: Secret,
			expiry: ctx.text,
		}));
		const after = schemaLockOf(
			appOf(
				blueprintOf((ctx) => ({
					amount: ctx.integer,
					by: variantOf("method", { card: CardWithExpiry, pix: Pix }),
					tried: ctx.listOf(Method),
				})),
			).describe(),
		);

		const field = before.entities.Order?.fields.by;
		expect(field?.schema).toEqual({ discriminator: "method", type: "object" });
		expect(Object.keys(field?.fields ?? {})).toEqual(["card", "pix"]);
		expect(
			diffSchemas(before, after).map(({ key, change }) => [key, change]),
		).toEqual([["by.card.expiry", "added-required"]]);
	});
});

test("OpenAPI gives one object per variant and names the key that tells them apart", () => {
	const schema = toOpenAPI(Payment) as {
		properties: { by: Record<string, unknown>; tried: { items: unknown } };
		required: string[];
	};

	expect(schema.properties.by).toEqual({
		oneOf: [
			{
				type: "object",
				properties: {
					method: { const: "card" },
					holder: expect.any(Object),
					number: expect.objectContaining({ writeOnly: true }),
				},
				required: ["method", "holder", "number"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: { method: { const: "pix" }, key: expect.any(Object) },
				required: ["method", "key"],
				additionalProperties: false,
			},
		],
		discriminator: { propertyName: "method" },
	});
	expect(schema.properties.tried.items).toEqual(schema.properties.by);
	expect(schema.required).toEqual(["amount", "by", "tried"]);
	expect(
		(
			toOpenAPI(blueprintOf((ctx) => ({ by: ctx.optionalOf(Method) }))) as {
				required?: string[];
			}
		).required,
	).toBeUndefined();
});

test("a variant field is picked whole by a slice, and not by its keys", () => {
	const Whole = sliceOf(Payment, { by: true });

	expect(Whole.safeParse({ by: pix }).issues).toBeUndefined();
	expect(() => sliceOf(Payment, { by: { key: true } } as never)).toThrow(
		InvalidBlueprintVariant,
	);
	expect(listOf(Method).item).toBe(Method);
});
