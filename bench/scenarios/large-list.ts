// Bulk: one object that holds a list of 1,000 small items.
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
import { aforaProperties, ajvInstance, eInt, eText } from "./shared.ts";

const SIZE = 1000;
const items = (raw: boolean) =>
	Array.from({ length: SIZE }, (_, position) => ({
		position,
		label: raw ? ` item ${position} ` : `item ${position}`,
		active: position % 2 === 0,
	}));
// One item in every hundred has an empty label and a string for `active`: 20 rules broken.
const invalid = {
	items: items(true).map((item, position) =>
		position % 100 === 50 ? { ...item, label: "  ", active: "yes" } : item,
	),
};

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const largeList = (afora: any): to.Scenario => {
	const strict = { additionalProperties: false };
	const tb = Type.Object(
		{
			items: Type.Array(
				Type.Object(
					{
						position: Type.Integer({ minimum: 0 }),
						label: Type.String({ minLength: 1 }),
						active: Type.Boolean(),
					},
					strict,
				),
			),
		},
		strict,
	);

	const ajvValidate = ajvInstance.compile({
		type: "object",
		additionalProperties: false,
		required: ["items"],
		properties: {
			items: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["position", "label", "active"],
					properties: {
						position: { type: "integer", minimum: 0 },
						label: { type: "string", minLength: 1 },
						active: { type: "boolean" },
					},
				},
			},
		},
	});

	const zList = z.strictObject({
		items: z.array(
			z.strictObject({
				position: z.number().int().min(0),
				label: z.string().trim().min(1),
				active: z.boolean(),
			}),
		),
	});

	const vList = v.strictObject({
		items: v.array(
			v.strictObject({
				position: v.pipe(v.number(), v.integer(), v.minValue(0)),
				label: v.pipe(v.string(), v.trim(), v.minLength(1)),
				active: v.boolean(),
			}),
		),
	});

	const aList = type({
		items: type({
			position: "number.integer >= 0",
			label: type("string.trim").to("string >= 1"),
			active: "boolean",
			"+": "reject",
		}).array(),
		"+": "reject",
	});

	const eList = S.Struct({
		items: S.Array(
			S.Struct({ position: eInt(0), label: eText(1), active: S.Boolean }),
		),
	});

	const yList = y
		.object({
			items: y
				.array()
				.of(
					y
						.object({
							position: y.number().required().integer().min(0),
							label: y.string().required().trim().min(1),
							active: y.boolean().required(),
						})
						.exact()
						.required(),
				)
				.required(),
		})
		.exact();

	const jList = Joi.object({
		items: Joi.array()
			.items(
				Joi.object({
					position: Joi.number().integer().min(0).required(),
					label: Joi.string().trim().min(1).required(),
					active: Joi.boolean().required(),
				}),
			)
			.required(),
	});

	const { blueprintOf, listOf } = afora;
	const property = aforaProperties(afora);
	const Position = property.integer("position", 0);
	const Label = property.text("label", 1);
	const Active = property.of("active", Type.Boolean());
	const Item = blueprintOf(() => ({
		position: Position,
		label: Label,
		active: Active,
	}));
	const List = blueprintOf(() => ({ items: listOf(Item) }));

	return {
		id: "large-list",
		title: "List of 1,000 items",
		shape:
			"`{ items: Array<{ position: integer >= 0, label: string (minLength 1, trimmed), active: boolean }> }` with 1,000 items. In the invalid input 10 of them break 2 rules each.",
		transforms: true,
		input: {
			valid: { items: items(true) },
			validClean: { items: items(false) },
			invalid,
		},
		contenders: [
			to.typebox(Compile(tb)),
			to.ajv(ajvValidate),
			to.typia(typiaValidators.list),
			to.zod(zList),
			to.valibot(vList),
			to.arktype(aList),
			to.effect(eList),
			to.yup(yList),
			to.joi(jList),
			...to.afora(afora, List),
		],
	};
};
