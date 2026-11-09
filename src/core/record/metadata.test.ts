import { expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { sliceOf, sliceValue } from "../blueprint/slice";
import {
	ENTITY_MEMBERS,
	RESERVED_ENTITY_KEYS,
} from "../entity/abstract-entity";
import { repositoryOf } from "../repository/repository";
import { Meta } from "../symbols/meta";
import { RESERVED_RECORD_KEYS, recordDataOf } from "./abstract-record";
import { ReservedRecordKey } from "./exceptions";
import { MASK } from "./mask";
import { recordPluginOf } from "./plugin";
import { recordOf } from "./record";
import type { RecordValue } from "./types/record.interface";

const Fields = blueprintOf((ctx) => ({
	blueprint: ctx.string,
	options: ctx.string,
}));
class Details extends recordOf(Fields, {
	sensitive: ["options"],
	change: ["blueprint"],
}) {}

test("metadata is immutable, shared and separate from domain data", () => {
	const value = new Details({ blueprint: "draft", options: "secret" });
	expect(value[Meta]).toEqual({
		blueprint: Details.blueprint,
		options: Details.options,
	});
	expect(value[Meta]).toBe(
		new Details({ blueprint: "other", options: "other" })[Meta],
	);
	expect(Object.isFrozen(value[Meta])).toBe(true);
	expect(Object.keys(value)).toEqual([]);
	expect({ ...value } as object).toEqual({});
	expect(
		Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(Object.getPrototypeOf(Details.prototype)),
			Meta,
		)?.enumerable,
	).toBe(false);
	expect(JSON.parse(JSON.stringify(value))).toEqual({
		blueprint: "draft",
		options: MASK,
	});
	value.change.blueprint("published");
	expect(recordDataOf(value)).toEqual({
		blueprint: "published",
		options: "secret",
	});
	expectTypeOf<RecordValue<Details>>().toEqualTypeOf<{
		blueprint: string;
		options: string;
	}>();
	expectTypeOf<RecordValue<typeof Details>>().toEqualTypeOf<
		RecordValue<Details>
	>();
	expectTypeOf(value[Meta].blueprint).toEqualTypeOf<typeof Fields>();
});

test("metadata remains available without string members and subclass collisions remain rejected", () => {
	class Empty extends recordOf(blueprintOf(() => ({}))) {}
	expect(new Empty({})).not.toHaveProperty("blueprint");
	expect(new Empty({})).not.toHaveProperty("options");
	class Collision extends Details {
		// @ts-expect-error a subclass cannot hide a domain field with a method
		blueprint() {
			return "hidden";
		}
	}
	expect(() => new Collision({ blueprint: "a", options: "b" })).toThrow(
		ReservedRecordKey,
	);
});

test("plugins, slice masks and sensitive nested records support metadata names", () => {
	const plugin = recordPluginOf("details", Details);
	class Wrapped extends recordOf(
		blueprintOf((ctx) => ({ name: ctx.string })),
		{ plugins: [plugin] },
	) {}
	const wrapped = new Wrapped({
		name: "A",
		blueprint: "draft",
		options: "secret",
	});
	wrapped.change.blueprint("published");
	expect(wrapped.toJSON()).toEqual({
		name: "A",
		blueprint: "published",
		options: MASK,
	});
	expect(sliceValue(wrapped, { blueprint: true, options: true })).toEqual({
		blueprint: "published",
		options: MASK,
	});
	const sliced = sliceOf(
		blueprintOf(() => ({ details: Details })),
		{ details: { options: true } },
	);
	expect(
		sliced.safeParse({
			details: new Details({ blueprint: "draft", options: "secret" }),
		}).issues,
	).toBeUndefined();
	class Secret extends recordOf(
		blueprintOf(() => ({ details: Details })),
		{ sensitive: ["details"] },
	) {}
	expect(
		new Secret({ details: { blueprint: "draft", options: "secret" } }).toJSON(),
	).toEqual({ details: { blueprint: MASK, options: MASK } });
});

test("entity equality and persistence use metadata independently of string fields", async () => {
	class Item extends entityOf(Fields, {
		sensitive: ["options"],
		change: ["blueprint"],
	}) {}
	const Items = repositoryOf({
		entity: Item,
		actions: ["create", "update", "findById"],
	});
	const item = await Items.create({ blueprint: "draft", options: "secret" });
	item.change.blueprint("published");
	await Items.update(item);
	const loaded = await Items.findById(item.id);
	expect(loaded?.blueprint).toBe("published");
	expect(loaded?.options).toBe("secret");
	expect(loaded?.equals(item)).toBe(true);
	expect(loaded?.toJSON().options).toBe(MASK);
	class Other extends entityOf(Fields) {}
	expect(
		item.equals(
			new Other({
				...recordDataOf(item),
				id: item.id,
				createdAt: item.createdAt,
				blueprint: "published",
				options: "secret",
			}),
		),
	).toBe(false);
});

test("reserved record and entity key lists are frozen contracts", () => {
	expect(RESERVED_RECORD_KEYS).toEqual([
		"onSet",
		"onSetAll",
		"set",
		"toJSON",
		"toString",
		"toLocaleString",
		"valueOf",
		"hasOwnProperty",
		"propertyIsEnumerable",
		"isPrototypeOf",
		"__defineGetter__",
		"__defineSetter__",
		"__lookupGetter__",
		"__lookupSetter__",
		"__proto__",
		"constructor",
	]);
	expect(ENTITY_MEMBERS).toEqual([
		"destroy",
		"isDeleted",
		"equals",
		"onDestroy",
		"emit",
		"pullEvents",
	]);
	expect(RESERVED_ENTITY_KEYS).toEqual([
		"id",
		"createdAt",
		"updatedAt",
		"deletedAt",
		...ENTITY_MEMBERS,
	]);
	for (const keys of [
		RESERVED_RECORD_KEYS,
		ENTITY_MEMBERS,
		RESERVED_ENTITY_KEYS,
	])
		expect(Object.isFrozen(keys)).toBe(true);
});
