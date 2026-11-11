import { type TSchema, Type } from "typebox";
import { collectionParserOf } from "../parse/parse";
import { isProperty } from "../property/is-property";
import { propertyOf } from "../property/property";
import { schemaOf } from "../schema/schema";
import { withStandard } from "../standard/standard";
import { Kind } from "../symbols/kind";
import { callableOf, fieldOf } from "./callable";
import {
	ReservedBlueprintKey,
	UndeclaredBlueprintProperty,
} from "./exceptions";
import { isBlueprint } from "./is-blueprint";
import { isBlueprintList, listOf } from "./list";
import { optionalOf } from "./optional";
import { recordFieldOf } from "./record-field";
import type {
	AnyBlueprint,
	BlueprintBuilder,
	BlueprintContext,
	BlueprintDefinition,
	BlueprintField,
	BlueprintSchema,
	BlueprintSource,
	IBlueprint,
	IBlueprintCollection,
} from "./types/blueprint.interface";
import type {
	IBlueprintFactories,
	IBlueprintPlugin,
} from "./types/blueprint-plugin.interface";

/**
 * A `blueprintOf` that builds blueprints from `base`, plugins or blueprints,
 * e.g. `blueprintBuilderOf(Std)`; sources given to it come after `base`.
 */
export function blueprintBuilderOf<
	const Base extends readonly BlueprintSource[],
>(...base: Base): BlueprintBuilder<Base> {
	return ((
		sourcesOrDefine:
			| readonly BlueprintSource[]
			| BlueprintDefinition<readonly BlueprintSource[], IBlueprintCollection>,
		maybeDefine?: BlueprintDefinition<
			readonly BlueprintSource[],
			IBlueprintCollection
		>,
	): IBlueprint<IBlueprintCollection> => {
		const [sources, define] =
			typeof sourcesOrDefine === "function"
				? [[] as readonly BlueprintSource[], sourcesOrDefine]
				: [
						sourcesOrDefine,
						maybeDefine as BlueprintDefinition<
							readonly BlueprintSource[],
							IBlueprintCollection
						>,
					];
		const all: readonly BlueprintSource[] = [...base, ...sources];

		return create(
			all.flatMap((source) =>
				isBlueprint(source) ? source.plugins : [source],
			),
			{ ...define(contextOf(all)) },
		);
	}) as BlueprintBuilder<Base>;
}

/** The blueprint of `properties`, built from `plugins`. */
export function blueprintFromProperties(
	plugins: readonly IBlueprintPlugin[],
	properties: IBlueprintCollection,
): IBlueprint<IBlueprintCollection> {
	return create(plugins, { ...properties });
}

function create(
	plugins: readonly IBlueprintPlugin[],
	properties: IBlueprintCollection,
): IBlueprint<IBlueprintCollection> {
	const shape: Record<string, TSchema> = {};
	for (const [key, field] of Object.entries(properties)) {
		properties[key] = fieldOf(field);
		shape[key] = schemaOfField(key, properties[key]);
	}

	const SchemaConstructor = schemaOf(
		"blueprint",
		Type.Object(shape) as BlueprintSchema<IBlueprintCollection>,
	);

	const safeParse = collectionParserOf(properties, "blueprint");
	const blueprint = {
		[Kind]: "blueprint" as const,
		plugins: Object.freeze([...new Set(plugins)]),
		properties: Object.freeze(properties),
		schema: new SchemaConstructor(),
		optional: false,
		safeParse,
		join: ((...others: readonly AnyBlueprint[]) =>
			create(
				[blueprint, ...others].flatMap((source) => source.plugins),
				Object.assign(
					{},
					...[blueprint, ...others].map((source) => source.properties),
				),
			)) as IBlueprint<IBlueprintCollection>["join"],
	} as IBlueprint<IBlueprintCollection>;

	return Object.freeze(withStandard(blueprint, safeParse));
}

/** Functions every context has, to make fields inline, as `ctx.listOf(ctx.id)`. */
const HELPERS = { listOf, optionalOf, propertyOf } as const;

/** Keys of the context that are not fields, so no source can declare them. */
const RESERVED_KEYS = ["optional", "list", ...Object.keys(HELPERS)];

/**
 * The fields of every source, the factories of its plugins (which replace a
 * field with the same name), `listOf`, `optionalOf` and `propertyOf`, the
 * optional versions of the fields under
 * `optional`, and a list of each under `list`, with `list.optional` for the
 * optional lists.
 */
function contextOf(
	sources: readonly BlueprintSource[],
): BlueprintContext<readonly BlueprintSource[]> {
	for (const key of RESERVED_KEYS) {
		const reserving = sources.find((source) =>
			Object.hasOwn(source.properties, key),
		);
		if (reserving) {
			throw new ReservedBlueprintKey({
				source: isBlueprint(reserving) ? "blueprint" : reserving.name,
				details: { key },
			});
		}
	}

	const factories: IBlueprintFactories = Object.assign(
		{},
		...sources.map((source) =>
			isBlueprint(source) ? {} : (source.factories ?? {}),
		),
	);
	for (const key of RESERVED_KEYS) {
		if (Object.hasOwn(factories, key)) {
			const reserving = sources.find(
				(source) =>
					!isBlueprint(source) && Object.hasOwn(source.factories ?? {}, key),
			) as IBlueprintPlugin;
			throw new ReservedBlueprintKey({
				source: reserving.name,
				details: { key },
			});
		}
	}

	const available: IBlueprintCollection = Object.assign(
		{},
		...sources.map((source) => source.properties),
	);
	for (const key of Object.keys(factories)) delete available[key];
	const mirror = (
		fields: IBlueprintCollection,
		map: (field: BlueprintField) => BlueprintField,
	): IBlueprintCollection =>
		Object.fromEntries(
			Object.entries(fields).map(([key, field]) => [key, map(field)]),
		);

	const list = mirror(available, (field) => listOf(field));
	const callable = (field: BlueprintField): BlueprintField =>
		isProperty(field) ? callableOf(field) : field;

	return Object.freeze({
		...mirror(available, callable),
		...factories,
		...HELPERS,
		optional: Object.freeze(
			mirror(available, (field) => callable(optionalOf(field))),
		),
		list: Object.freeze({
			...list,
			optional: Object.freeze(mirror(list, optionalOf)),
		}),
	}) as BlueprintContext<readonly BlueprintSource[]>;
}

/**
 * The schema of `field`; a blueprint becomes a nested object, as does a record,
 * by its blueprint, and a list an array.
 */
function schemaOfField(
	key: string,
	field: BlueprintField | undefined,
): TSchema {
	if (isBlueprintList(field)) {
		const { item, minItems, maxItems } = field;
		const schema = Type.Array(schemaOfField(key, item), {
			...(minItems === undefined ? {} : { minItems }),
			...(maxItems === undefined ? {} : { maxItems }),
		});
		return field.optional ? Type.Optional(schema) : schema;
	}
	if (isBlueprint(field)) {
		const schema = field.schema.type.Type();
		return field.optional ? Type.Optional(schema) : schema;
	}
	const record = recordFieldOf(field);
	if (record) {
		const schema = record.record.blueprint.schema.type.Type();
		return record.optional ? Type.Optional(schema) : schema;
	}
	if (isProperty(field)) {
		return field.type.schema.type.Type();
	}

	throw new UndeclaredBlueprintProperty({
		source: "blueprint",
		details: { key },
	});
}
