// Six objects, one inside the other.
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

const DEPTH = 6;
/** Wraps `leaf` in `DEPTH - 1` levels made by `level`. */
function nest<Node>(leaf: Node, level: (child: Node) => Node): Node {
	let node = leaf;
	for (let depth = 1; depth < DEPTH; depth++) node = level(node);
	return node;
}

type Value = { name: unknown; count: unknown; child?: Value };
const value = (raw: boolean): Value =>
	nest<Value>({ name: raw ? " level " : "level", count: 1 }, (child) => ({
		name: raw ? " level " : "level",
		count: 1,
		child,
	}));
// 4 rules broken: the count of level 1, the name of level 3, and both keys of level 6.
const invalid = value(true);
invalid.count = -1;
(invalid.child?.child as Value).name = "  ";
(invalid.child?.child?.child?.child as Value).child = { count: "x" } as Value;

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const deep = (afora: any): to.Scenario => {
	const strict = { additionalProperties: false };
	const tbLeaf = {
		name: Type.String({ minLength: 1 }),
		count: Type.Integer({ minimum: 0 }),
	};
	// biome-ignore lint/suspicious/noExplicitAny: each level has its own type
	const tb = nest<any>(Type.Object(tbLeaf, strict), (child) =>
		Type.Object({ ...tbLeaf, child }, strict),
	);

	const ajvLeaf = {
		name: { type: "string", minLength: 1 },
		count: { type: "integer", minimum: 0 },
	};
	const ajvValidate = ajvInstance.compile(
		nest<object>(
			{
				type: "object",
				additionalProperties: false,
				required: ["name", "count"],
				properties: ajvLeaf,
			},
			(child) => ({
				type: "object",
				additionalProperties: false,
				required: ["name", "count", "child"],
				properties: { ...ajvLeaf, child },
			}),
		),
	);

	const zLeaf = {
		name: z.string().trim().min(1),
		count: z.number().int().min(0),
	};
	const zDeep = nest<z.ZodType>(z.strictObject(zLeaf), (child) =>
		z.strictObject({ ...zLeaf, child }),
	);

	const vLeaf = {
		name: v.pipe(v.string(), v.trim(), v.minLength(1)),
		count: v.pipe(v.number(), v.integer(), v.minValue(0)),
	};
	const vDeep = nest<v.GenericSchema>(v.strictObject(vLeaf), (child) =>
		v.strictObject({ ...vLeaf, child }),
	);

	const aLeaf = {
		name: type("string.trim").to("string >= 1"),
		count: "number.integer >= 0",
		"+": "reject",
	} as const;
	// biome-ignore lint/suspicious/noExplicitAny: each level has its own type
	const aDeep = nest<any>(type(aLeaf), (child) => type({ ...aLeaf, child }));

	const eLeaf = { name: eText(1), count: eInt(0) };
	// biome-ignore lint/suspicious/noExplicitAny: each level has its own type
	const eDeep = nest<any>(S.Struct(eLeaf), (child) =>
		S.Struct({ ...eLeaf, child }),
	);

	const yLeaf = {
		name: y.string().required().trim().min(1),
		count: y.number().required().integer().min(0),
	};
	// biome-ignore lint/suspicious/noExplicitAny: each level has its own type
	const yDeep = nest<any>(y.object(yLeaf).exact().required(), (child) =>
		y
			.object({ ...yLeaf, child })
			.exact()
			.required(),
	);

	const jLeaf = {
		name: Joi.string().trim().min(1).required(),
		count: Joi.number().integer().min(0).required(),
	};
	const jDeep = nest<Joi.Schema>(Joi.object(jLeaf).required(), (child) =>
		Joi.object({ ...jLeaf, child }).required(),
	);

	const { blueprintOf } = afora;
	const property = aforaProperties(afora);
	const Name = property.text("name", 1);
	const Count = property.integer("count", 0);
	// biome-ignore lint/suspicious/noExplicitAny: each level has its own type
	const Deep = nest<any>(
		blueprintOf(() => ({ name: Name, count: Count })),
		(child) => blueprintOf(() => ({ name: Name, count: Count, child })),
	);

	return {
		id: "deep",
		title: "6 levels of nesting",
		shape:
			"`{ name: string (minLength 1, trimmed), count: integer >= 0, child: { ...the same, 6 levels deep } }`. 4 rules broken in the invalid input, at levels 1, 3 and 6.",
		transforms: true,
		input: { valid: value(true), validClean: value(false), invalid },
		contenders: [
			to.typebox(Compile(tb)),
			to.ajv(ajvValidate),
			to.typia(typiaValidators.deep),
			to.zod(zDeep),
			to.valibot(vDeep),
			to.arktype(aDeep),
			to.effect(eDeep),
			to.yup(yDeep),
			to.joi(jDeep),
			...to.afora(afora, Deep),
		],
	};
};
