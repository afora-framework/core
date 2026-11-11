// A feed of 12 events, each one of four variants told apart by `type`.
// Nothing is transformed.
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

const variants = [
	{ type: "click", x: 120, y: 48 },
	{ type: "view", url: "https://example.com/pricing", durationMs: 5400 },
	{ type: "purchase", orderId: "order-1001", amount: 129.9, currency: "BRL" },
	{ type: "signup", email: "alice@example.com", plan: "pro" },
];
const valid = {
	events: Array.from({ length: 12 }, (_, index) => ({
		...variants[index % 4],
	})),
};
// 3 events broken: a variant that does not exist, a negative amount, a malformed email.
const invalid = {
	events: valid.events.map((event, index) => {
		if (index === 1) return { ...event, type: "scroll" };
		if (index === 6) return { ...event, amount: -5 };
		if (index === 11) return { ...event, email: "not-an-email" };
		return event;
	}),
};

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const union = (afora: any): to.Scenario => {
	const strict = { additionalProperties: false };
	const tbEvent = Type.Union([
		Type.Object(
			{
				type: Type.Literal("click"),
				x: Type.Integer({ minimum: 0 }),
				y: Type.Integer({ minimum: 0 }),
			},
			strict,
		),
		Type.Object(
			{
				type: Type.Literal("view"),
				url: Type.String({ minLength: 1 }),
				durationMs: Type.Integer({ minimum: 0 }),
			},
			strict,
		),
		Type.Object(
			{
				type: Type.Literal("purchase"),
				orderId: Type.String({ minLength: 1 }),
				amount: Type.Number({ minimum: 0 }),
				currency: Type.String({ minLength: 3, maxLength: 3 }),
			},
			strict,
		),
		Type.Object(
			{
				type: Type.Literal("signup"),
				email: Type.String({ format: "email" }),
				plan: Type.Union([Type.Literal("free"), Type.Literal("pro")]),
			},
			strict,
		),
	]);
	const tb = Type.Object({ events: Type.Array(tbEvent) }, strict);

	const ajvVariant = (
		tag: string,
		properties: Record<string, object>,
	): object => ({
		type: "object",
		additionalProperties: false,
		required: ["type", ...Object.keys(properties)],
		properties: { type: { const: tag }, ...properties },
	});
	// `discriminator` lets Ajv pick the variant by `type` instead of trying each.
	const ajvValidate = ajvInstance.compile({
		type: "object",
		additionalProperties: false,
		required: ["events"],
		properties: {
			events: {
				type: "array",
				items: {
					type: "object",
					discriminator: { propertyName: "type" },
					required: ["type"],
					oneOf: [
						ajvVariant("click", {
							x: { type: "integer", minimum: 0 },
							y: { type: "integer", minimum: 0 },
						}),
						ajvVariant("view", {
							url: { type: "string", minLength: 1 },
							durationMs: { type: "integer", minimum: 0 },
						}),
						ajvVariant("purchase", {
							orderId: { type: "string", minLength: 1 },
							amount: { type: "number", minimum: 0 },
							currency: { type: "string", minLength: 3, maxLength: 3 },
						}),
						ajvVariant("signup", {
							email: { type: "string", format: "email" },
							plan: { enum: ["free", "pro"] },
						}),
					],
				},
			},
		},
	});

	const zEvents = z.strictObject({
		events: z.array(
			z.discriminatedUnion("type", [
				z.strictObject({
					type: z.literal("click"),
					x: z.number().int().min(0),
					y: z.number().int().min(0),
				}),
				z.strictObject({
					type: z.literal("view"),
					url: z.string().min(1),
					durationMs: z.number().int().min(0),
				}),
				z.strictObject({
					type: z.literal("purchase"),
					orderId: z.string().min(1),
					amount: z.number().min(0),
					currency: z.string().length(3),
				}),
				z.strictObject({
					type: z.literal("signup"),
					email: z.email(),
					plan: z.enum(["free", "pro"]),
				}),
			]),
		),
	});

	const vInt = v.pipe(v.number(), v.integer(), v.minValue(0));
	const vText = v.pipe(v.string(), v.minLength(1));
	const vEvents = v.strictObject({
		events: v.array(
			v.variant("type", [
				v.strictObject({ type: v.literal("click"), x: vInt, y: vInt }),
				v.strictObject({
					type: v.literal("view"),
					url: vText,
					durationMs: vInt,
				}),
				v.strictObject({
					type: v.literal("purchase"),
					orderId: vText,
					amount: v.pipe(v.number(), v.minValue(0)),
					currency: v.pipe(v.string(), v.length(3)),
				}),
				v.strictObject({
					type: v.literal("signup"),
					email: v.pipe(v.string(), v.email()),
					plan: v.picklist(["free", "pro"]),
				}),
			]),
		),
	});

	const aEvent = type({
		type: "'click'",
		x: "number.integer >= 0",
		y: "number.integer >= 0",
		"+": "reject",
	})
		.or({
			type: "'view'",
			url: "string >= 1",
			durationMs: "number.integer >= 0",
			"+": "reject",
		})
		.or({
			type: "'purchase'",
			orderId: "string >= 1",
			amount: "number >= 0",
			currency: "string == 3",
			"+": "reject",
		})
		.or({
			type: "'signup'",
			email: "string.email",
			plan: "'free' | 'pro'",
			"+": "reject",
		});
	const aEvents = type({ events: aEvent.array(), "+": "reject" });

	const eEvents = S.Struct({
		events: S.Array(
			S.Union([
				S.Struct({ type: S.Literal("click"), x: eInt(0), y: eInt(0) }),
				S.Struct({
					type: S.Literal("view"),
					url: eText(1, false),
					durationMs: eInt(0),
				}),
				S.Struct({
					type: S.Literal("purchase"),
					orderId: eText(1, false),
					amount: S.Number.check(S.isGreaterThanOrEqualTo(0)),
					currency: S.String.check(S.isMinLength(3), S.isMaxLength(3)),
				}),
				S.Struct({
					type: S.Literal("signup"),
					email: eEmail(false),
					plan: S.Literals(["free", "pro"]),
				}),
			]),
		),
	});

	// Yup has no union: `lazy` picks the schema of the variant from the value.
	const yTag = (tag: string) => y.string().required().oneOf([tag]);
	const yInt = y.number().required().integer().min(0);
	const yVariants: Record<string, y.Schema> = {
		click: y.object({ type: yTag("click"), x: yInt, y: yInt }).exact(),
		view: y
			.object({
				type: yTag("view"),
				url: y.string().required().min(1),
				durationMs: yInt,
			})
			.exact(),
		purchase: y
			.object({
				type: yTag("purchase"),
				orderId: y.string().required().min(1),
				amount: y.number().required().min(0),
				currency: y.string().required().length(3),
			})
			.exact(),
		signup: y
			.object({
				type: yTag("signup"),
				email: y.string().required().email(),
				plan: y.string().required().oneOf(["free", "pro"]),
			})
			.exact(),
	};
	const yUnknown = y
		.mixed()
		.test("variant", "is not a known event", () => false);
	const yEvents = y
		.object({
			events: y
				.array()
				.of(
					y.lazy(
						(value: { type?: string } | undefined) =>
							yVariants[value?.type ?? ""] ?? yUnknown,
						// biome-ignore lint/suspicious/noExplicitAny: `of` wants one schema type
					) as any,
				)
				.required(),
		})
		.exact();

	const jInt = Joi.number().integer().min(0).required();
	const jEvents = Joi.object({
		events: Joi.array()
			.items(
				Joi.alternatives().try(
					Joi.object({
						type: Joi.string().valid("click").required(),
						x: jInt,
						y: jInt,
					}),
					Joi.object({
						type: Joi.string().valid("view").required(),
						url: Joi.string().min(1).required(),
						durationMs: jInt,
					}),
					Joi.object({
						type: Joi.string().valid("purchase").required(),
						orderId: Joi.string().min(1).required(),
						amount: Joi.number().min(0).required(),
						currency: Joi.string().length(3).required(),
					}),
					Joi.object({
						type: Joi.string().valid("signup").required(),
						email: Joi.string().email({ tlds: false }).required(),
						plan: Joi.string().valid("free", "pro").required(),
					}),
				),
			)
			.required(),
	});

	// In afora a union is the schema of one property.
	const { blueprintOf, listOf } = afora;
	const Event = aforaProperties(afora).of("event", tbEvent);
	const Events = blueprintOf(() => ({ events: listOf(Event) }));

	return {
		id: "union",
		title: "Union of 4 variants (12 events)",
		shape:
			"`{ events: Event[] }` with 12 events, where `Event` is `click { x, y }`, `view { url, durationMs }`, `purchase { orderId, amount, currency }` or `signup { email, plan }`, told apart by `type`. No transforms. 3 events broken in the invalid input.",
		transforms: false,
		input: { valid, validClean: valid, invalid },
		contenders: [
			to.typebox(Compile(tb)),
			to.ajv(ajvValidate),
			to.typia(typiaValidators.events),
			to.zod(zEvents),
			to.valibot(vEvents),
			to.arktype(aEvents),
			to.effect(eEvents),
			to.yup(yEvents),
			to.joi(jEvents),
			...to.afora(afora, Events),
		],
	};
};
