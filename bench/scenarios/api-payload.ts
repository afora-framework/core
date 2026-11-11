// The body of a request: an order placed in a shop, with a customer, a
// shipping address, five items, an enum, optional keys, a uuid and a date.
import { type } from "arktype";
import * as S from "effect/Schema";
import Joi from "joi";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import * as v from "valibot";
import * as y from "yup";
import { z } from "zod";
import * as to from "../contenders.ts";
import * as typiaValidators from "../typia/generated/validators.js";
import { aforaProperties, ajvInstance, eEmail, eInt, eText } from "./shared.ts";

const STATUS = ["pending", "paid", "shipped", "cancelled"] as const;
const DATE_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const item = (index: number, raw: boolean) => ({
	sku: `SKU-${1000 + index}`,
	name: raw ? `  Coffee beans ${index} ` : `Coffee beans ${index}`,
	quantity: index + 1,
	price: 19.9 + index,
});
const order = (raw: boolean) => ({
	cartId: "9b2f6c1e-3d4a-4e8b-9f1a-2c3d4e5f6a7b",
	status: "paid",
	customer: {
		name: raw ? "  Alice Souza " : "Alice Souza",
		email: raw ? " Alice@Example.COM " : "alice@example.com",
		phone: "+55 11 91234-5678",
	},
	shipping: {
		street: raw ? " Avenida Paulista 1000 " : "Avenida Paulista 1000",
		city: raw ? " São Paulo" : "São Paulo",
		zip: "01310-100",
		country: "BR",
	},
	items: Array.from({ length: 5 }, (_, index) => item(index, raw)),
	notes: "Leave it at the front desk.",
	placedAt: "2026-11-10T12:30:00.000Z",
});
// 8 rules broken: cartId, status, customer.email, shipping.zip (wrong type),
// shipping.country, items[2].quantity, items[2].price and placedAt.
const invalid = {
	...order(true),
	cartId: "not-a-uuid",
	status: "lost",
	customer: { name: "Alice Souza", email: "not-an-email" },
	shipping: {
		street: "Avenida Paulista 1000",
		city: "São Paulo",
		zip: 1310,
		country: "BRA",
	},
	items: Array.from({ length: 5 }, (_, index) =>
		index === 2
			? { ...item(index, true), quantity: 0, price: -1 }
			: item(index, true),
	),
	placedAt: "yesterday",
};

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const apiPayload = (afora: any): to.Scenario => {
	const strict = { additionalProperties: false };
	const tb = Type.Object(
		{
			cartId: Type.String({ format: "uuid" }),
			status: Type.Union(STATUS.map((status) => Type.Literal(status))),
			customer: Type.Object(
				{
					name: Type.String({ minLength: 2 }),
					email: Type.String({ format: "email" }),
					phone: Type.Optional(Type.String({ minLength: 8 })),
				},
				strict,
			),
			shipping: Type.Object(
				{
					street: Type.String({ minLength: 1 }),
					city: Type.String({ minLength: 1 }),
					zip: Type.String({ minLength: 5 }),
					country: Type.String({ minLength: 2, maxLength: 2 }),
				},
				strict,
			),
			items: Type.Array(
				Type.Object(
					{
						sku: Type.String({ minLength: 3 }),
						name: Type.String({ minLength: 1 }),
						quantity: Type.Integer({ minimum: 1 }),
						price: Type.Number({ minimum: 0 }),
					},
					strict,
				),
				{ minItems: 1 },
			),
			coupon: Type.Optional(Type.String({ minLength: 1 })),
			notes: Type.Optional(Type.String({ maxLength: 500 })),
			placedAt: Type.String({ format: "date-time" }),
		},
		strict,
	);

	const ajvValidate = ajvInstance.compile({
		type: "object",
		additionalProperties: false,
		required: ["cartId", "status", "customer", "shipping", "items", "placedAt"],
		properties: {
			cartId: { type: "string", format: "uuid" },
			status: { enum: [...STATUS] },
			customer: {
				type: "object",
				additionalProperties: false,
				required: ["name", "email"],
				properties: {
					name: { type: "string", minLength: 2 },
					email: { type: "string", format: "email" },
					phone: { type: "string", minLength: 8 },
				},
			},
			shipping: {
				type: "object",
				additionalProperties: false,
				required: ["street", "city", "zip", "country"],
				properties: {
					street: { type: "string", minLength: 1 },
					city: { type: "string", minLength: 1 },
					zip: { type: "string", minLength: 5 },
					country: { type: "string", minLength: 2, maxLength: 2 },
				},
			},
			items: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["sku", "name", "quantity", "price"],
					properties: {
						sku: { type: "string", minLength: 3 },
						name: { type: "string", minLength: 1 },
						quantity: { type: "integer", minimum: 1 },
						price: { type: "number", minimum: 0 },
					},
				},
			},
			coupon: { type: "string", minLength: 1 },
			notes: { type: "string", maxLength: 500 },
			placedAt: { type: "string", format: "date-time" },
		},
	});

	const zOrder = z.strictObject({
		cartId: z.uuid(),
		status: z.enum(STATUS),
		customer: z.strictObject({
			name: z.string().trim().min(2),
			email: z.string().trim().toLowerCase().email(),
			phone: z.string().min(8).optional(),
		}),
		shipping: z.strictObject({
			street: z.string().trim().min(1),
			city: z.string().trim().min(1),
			zip: z.string().min(5),
			country: z.string().length(2),
		}),
		items: z
			.array(
				z.strictObject({
					sku: z.string().min(3),
					name: z.string().trim().min(1),
					quantity: z.number().int().min(1),
					price: z.number().min(0),
				}),
			)
			.min(1),
		coupon: z.string().min(1).optional(),
		notes: z.string().max(500).optional(),
		placedAt: z.iso.datetime(),
	});

	const vTrimmed = (min: number) =>
		v.pipe(v.string(), v.trim(), v.minLength(min));
	const vText = (min: number) => v.pipe(v.string(), v.minLength(min));
	const vOrder = v.strictObject({
		cartId: v.pipe(v.string(), v.uuid()),
		status: v.picklist(STATUS),
		customer: v.strictObject({
			name: vTrimmed(2),
			email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
			phone: v.optional(vText(8)),
		}),
		shipping: v.strictObject({
			street: vTrimmed(1),
			city: vTrimmed(1),
			zip: vText(5),
			country: v.pipe(v.string(), v.length(2)),
		}),
		items: v.pipe(
			v.array(
				v.strictObject({
					sku: vText(3),
					name: vTrimmed(1),
					quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
					price: v.pipe(v.number(), v.minValue(0)),
				}),
			),
			v.minLength(1),
		),
		coupon: v.optional(vText(1)),
		notes: v.optional(v.pipe(v.string(), v.maxLength(500))),
		placedAt: v.pipe(v.string(), v.isoTimestamp()),
	});

	const aTrimmed = (min: number) => type("string.trim").to(`string >= ${min}`);
	const aOrder = type({
		cartId: "string.uuid",
		status: "'pending' | 'paid' | 'shipped' | 'cancelled'",
		customer: {
			name: aTrimmed(2),
			email: type("string.trim")
				.pipe((value: string) => value.toLowerCase())
				.to("string.email"),
			"phone?": "string >= 8",
			"+": "reject",
		},
		shipping: {
			street: aTrimmed(1),
			city: aTrimmed(1),
			zip: "string >= 5",
			country: "string == 2",
			"+": "reject",
		},
		items: type({
			sku: "string >= 3",
			name: aTrimmed(1),
			quantity: "number.integer >= 1",
			price: "number >= 0",
			"+": "reject",
		})
			.array()
			.atLeastLength(1),
		"coupon?": "string >= 1",
		"notes?": "string <= 500",
		placedAt: "string.date.iso",
		"+": "reject",
	});

	// Effect has no date-time check for strings; a pattern stands for it.
	const eOrder = S.Struct({
		cartId: S.String.check(S.isUUID()),
		status: S.Literals(STATUS),
		customer: S.Struct({
			name: eText(2),
			email: eEmail(),
			phone: S.optionalKey(eText(8, false)),
		}),
		shipping: S.Struct({
			street: eText(1),
			city: eText(1),
			zip: eText(5, false),
			country: S.String.check(S.isMinLength(2), S.isMaxLength(2)),
		}),
		items: S.Array(
			S.Struct({
				sku: eText(3, false),
				name: eText(1),
				quantity: eInt(1),
				price: S.Number.check(S.isGreaterThanOrEqualTo(0)),
			}),
		).check(S.isMinLength(1)),
		coupon: S.optionalKey(eText(1, false)),
		notes: S.optionalKey(S.String.check(S.isMaxLength(500))),
		placedAt: S.String.check(S.isPattern(DATE_TIME)),
	});

	const yOrder = y
		.object({
			cartId: y.string().required().uuid(),
			status: y.string().required().oneOf(STATUS),
			customer: y
				.object({
					name: y.string().required().trim().min(2),
					email: y.string().required().trim().lowercase().email(),
					phone: y.string().min(8),
				})
				.exact()
				.required(),
			shipping: y
				.object({
					street: y.string().required().trim().min(1),
					city: y.string().required().trim().min(1),
					zip: y.string().required().min(5),
					country: y.string().required().length(2),
				})
				.exact()
				.required(),
			items: y
				.array()
				.of(
					y
						.object({
							sku: y.string().required().min(3),
							name: y.string().required().trim().min(1),
							quantity: y.number().required().integer().min(1),
							price: y.number().required().min(0),
						})
						.exact()
						.required(),
				)
				.required()
				.min(1),
			coupon: y.string().min(1),
			notes: y.string().max(500),
			placedAt: y.string().required().datetime(),
		})
		.exact();

	const jOrder = Joi.object({
		cartId: Joi.string().uuid().required(),
		status: Joi.string()
			.valid(...STATUS)
			.required(),
		customer: Joi.object({
			name: Joi.string().trim().min(2).required(),
			email: Joi.string().trim().lowercase().email({ tlds: false }).required(),
			phone: Joi.string().min(8),
		}).required(),
		shipping: Joi.object({
			street: Joi.string().trim().min(1).required(),
			city: Joi.string().trim().min(1).required(),
			zip: Joi.string().min(5).required(),
			country: Joi.string().length(2).required(),
		}).required(),
		items: Joi.array()
			.items(
				Joi.object({
					sku: Joi.string().min(3).required(),
					name: Joi.string().trim().min(1).required(),
					quantity: Joi.number().integer().min(1).required(),
					price: Joi.number().min(0).required(),
				}),
			)
			.min(1)
			.required(),
		coupon: Joi.string().min(1),
		notes: Joi.string().max(500),
		placedAt: Joi.string().isoDate().required(),
	});

	const { blueprintOf, enumOf, listOf, optionalOf } = afora;
	const property = aforaProperties(afora);
	const CartId = property.of("cartId", Type.String({ format: "uuid" }));
	const Status = enumOf([...STATUS], { name: "status" });
	const CustomerName = property.text("customerName", 2);
	const Email = property.email("email");
	const Phone = property.text("phone", 8, false);
	const Street = property.text("street", 1);
	const City = property.text("city", 1);
	const Zip = property.text("zip", 5, false);
	const Country = property.of(
		"country",
		Type.String({ minLength: 2, maxLength: 2 }),
	);
	const Sku = property.text("sku", 3, false);
	const ItemName = property.text("itemName", 1);
	const Quantity = property.integer("quantity", 1);
	const Price = property.of("price", Type.Number({ minimum: 0 }));
	const Coupon = property.text("coupon", 1, false);
	const Notes = property.of("notes", Type.String({ maxLength: 500 }));
	const PlacedAt = property.of(
		"placedAt",
		Type.String({ format: "date-time" }),
	);

	const Customer = blueprintOf(() => ({
		name: CustomerName,
		email: Email,
		phone: optionalOf(Phone),
	}));
	const Shipping = blueprintOf(() => ({
		street: Street,
		city: City,
		zip: Zip,
		country: Country,
	}));
	const Item = blueprintOf(() => ({
		sku: Sku,
		name: ItemName,
		quantity: Quantity,
		price: Price,
	}));
	const Order = blueprintOf(() => ({
		cartId: CartId,
		status: Status,
		customer: Customer,
		shipping: Shipping,
		items: listOf(Item, { minItems: 1 }),
		coupon: optionalOf(Coupon),
		notes: optionalOf(Notes),
		placedAt: PlacedAt,
	}));

	return {
		id: "api-payload",
		title: "API request body (an order with 5 items)",
		shape:
			"An order: `cartId` (uuid), `status` (one of four), `customer { name, email, phone? }`, `shipping { street, city, zip, country }`, `items[5] { sku, name, quantity, price }`, optional `coupon` and `notes`, `placedAt` (date-time). Names, street and city are trimmed, the email is trimmed and lowercased. 8 rules broken in the invalid input.",
		transforms: true,
		input: { valid: order(true), validClean: order(false), invalid },
		contenders: [
			to.typebox(Compile(tb)),
			to.ajv(ajvValidate),
			to.typia(typiaValidators.order),
			to.zod(zOrder),
			to.valibot(vOrder),
			to.arktype(aOrder),
			to.effect(eOrder),
			to.yup(yOrder),
			to.joi(jOrder),
			...to.afora(afora, Order),
		],
	};
};
