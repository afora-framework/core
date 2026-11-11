// A variant that is a record class, or an entity, instead of a blueprint.
import { describe, expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import type { IRepositoryProvider } from "../../adapters";
import {
	blueprintOf,
	entityOf,
	InvalidBlueprintVariant,
	inMemoryProvider,
	propertyOf,
	recordOf,
	repositoryOf,
	toOpenAPI,
	variantOf,
} from "../../index";

const Secret = propertyOf({
	name: "secret",
	schema: Type.String({ minLength: 1 }),
	sensitive: true,
});

class Card extends recordOf(
	blueprintOf((ctx) => ({ holder: ctx.text, number: Secret })),
	{ name: "Card" },
) {
	get last4() {
		return this.number.slice(-4);
	}
}
const Pix = blueprintOf((ctx) => ({ key: ctx.email }));
const Method = variantOf("method", { card: Card, pix: Pix });
const Payment = blueprintOf((ctx) => ({ amount: ctx.integer, by: Method }));

/** The value of a parse that is expected to accept. */
function accepted<Value>(
	result:
		| { readonly issues?: undefined; readonly value: Value }
		| {
				readonly issues: readonly unknown[];
		  },
): Value {
	if (result.issues) throw new Error(JSON.stringify(result.issues));
	return result.value;
}

describe("a record class as a variant", () => {
	test("a plain value with the key becomes an instance of the class it names", () => {
		const { by } = accepted(
			Payment.safeParse({
				amount: 10,
				by: { method: "card", holder: "Jane", number: "4111 1111" },
			}),
		);

		expect(by).toBeInstanceOf(Card);
		// The class tells which variant it is; the key is not on the instance.
		if (by instanceof Card) {
			expect(by.last4).toBe("1111");
			expect("method" in by).toBe(false);
		}
		expectTypeOf(by).toEqualTypeOf<
			Card | { readonly method: "pix"; key: string }
		>();
	});

	test("an instance is kept, and a blueprint variant is still a plain value", () => {
		const card = new Card({ holder: "Jane", number: "4111" });

		expect(accepted(Payment.safeParse({ amount: 1, by: card })).by).toBe(card);
		expect(
			accepted(
				Payment.safeParse({ amount: 1, by: { method: "pix", key: "a@b.co" } }),
			).by,
		).toEqual({ method: "pix", key: "a@b.co" });
	});

	test("the issues of the record are at the path of the field", () => {
		const { issues } = Payment.safeParse({
			amount: 1,
			by: { method: "card", holder: "", extra: 1 },
		});

		expect(issues?.map(({ path, code }) => [path.join("."), code])).toEqual([
			["by.extra", "undeclared_key"],
			["by.holder", "invalid_value"],
			["by.number", "required"],
		]);
	});

	test("an instance of another class is not a variant", () => {
		class Other extends recordOf(
			blueprintOf((ctx) => ({ holder: ctx.text })),
		) {}

		expect(
			Payment.safeParse({
				amount: 1,
				by: new Other({ holder: "Jane" }),
			}).issues?.map(({ path, code }) => [path.join("."), code]),
		).toEqual([["by.method", "invalid_value"]]);
	});

	test("toJSON gives the key first, then what the record gives, masked by it", () => {
		class Paid extends recordOf(Payment) {}
		const paid = new Paid({
			amount: 10,
			by: { method: "card", holder: "Jane", number: "4111" },
		});

		expect(paid.by).toBeInstanceOf(Card);
		expect(paid.toJSON()).toEqual({
			amount: 10,
			by: { method: "card", holder: "Jane", number: "********" },
		});
		expect(Object.keys(paid.toJSON().by)).toEqual([
			"method",
			"holder",
			"number",
		]);
	});

	test("OpenAPI writes the record out with the key", () => {
		const schema = toOpenAPI(Payment) as {
			properties: {
				by: { oneOf: { properties: object; required: string[] }[] };
			};
		};
		const [card] = schema.properties.by.oneOf;

		expect(Object.keys(card?.properties ?? {})).toEqual([
			"method",
			"holder",
			"number",
		]);
		expect(card?.required).toEqual(["method", "holder", "number"]);
	});

	test.each<[string, () => unknown]>([
		[
			"a class that is two variants",
			() => variantOf("method", { card: Card, credit: Card }),
		],
		[
			"a class whose blueprint declares the key",
			() => variantOf("holder", { card: Card }),
		],
	])("variantOf rejects %s", (_, declare) => {
		expect(declare).toThrow(InvalidBlueprintVariant);
	});
});

describe("an entity as a variant", () => {
	class Person extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.text })),
		{ name: "Person" },
	) {}
	class Company extends entityOf(
		blueprintOf((ctx) => ({ legalName: ctx.text })),
		{ name: "Company" },
	) {}
	const Note = blueprintOf((ctx) => ({ text: ctx.text }));
	class Invoice extends entityOf(
		blueprintOf((ctx) => ({
			total: ctx.integer,
			payer: variantOf("kind", {
				person: Person,
				company: Company,
				note: Note,
			}),
			others: ctx.listOf(variantOf("kind", { person: Person, note: Note })),
		})),
		{ name: "Invoice" },
	) {}

	function setup() {
		const inserted: unknown[] = [];
		const memory = inMemoryProvider();
		const provider: IRepositoryProvider = {
			...memory,
			async insert(context, data) {
				inserted.push(data);
				return memory.insert(context, data);
			},
		};
		const People = repositoryOf({
			entity: Person,
			actions: ["create", "findById", "update"],
		});
		const Companies = repositoryOf({
			entity: Company,
			actions: ["create", "findById"],
		});
		const Invoices = repositoryOf({
			entity: Invoice,
			provider,
			relations: [People, Companies],
			actions: ["create", "findById", "update"],
		});
		return { People, Companies, Invoices, inserted };
	}

	test("it is stored by reference with the key, and read back as the entity", async () => {
		const { People, Companies, Invoices, inserted } = setup();
		const jane = await People.create(new Person({ name: "Jane" }));
		const acme = await Companies.create(new Company({ legalName: "Acme" }));
		const created = await Invoices.create(
			new Invoice({
				total: 10,
				payer: acme,
				others: [jane, { kind: "note", text: "paid in cash" }],
			}),
		);

		expect(inserted[0]).toMatchObject({
			payer: { kind: "company", id: acme.id },
			others: [
				{ kind: "person", id: jane.id },
				{ kind: "note", text: "paid in cash" },
			],
		});

		const found = await Invoices.findById(created.id);
		if (!found) throw new Error("The invoice was not found.");
		const { payer, others } = found;
		expect(payer).toBeInstanceOf(Company);
		expect(payer instanceof Company && payer.legalName).toBe("Acme");
		expect(others[0]).toBeInstanceOf(Person);
		expect(others[0] instanceof Person && others[0].id).toBe(jane.id);
		expect(others[1]).toEqual({ kind: "note", text: "paid in cash" });
		expect(found.toJSON().payer).toMatchObject({
			kind: "company",
			legalName: "Acme",
		});
	});

	test("a change to the entity it refers to is what the next read gives", async () => {
		const { People, Invoices } = setup();
		const jane = await People.create(new Person({ name: "Jane" }));
		const { id } = await Invoices.create(
			new Invoice({ total: 1, payer: jane, others: [] }),
		);

		const renamed = new Person({ ...jane.toJSON(), name: "Janet" });
		await People.update(renamed);

		const payer = (await Invoices.findById(id))?.payer;
		expect(payer instanceof Person && payer.name).toBe("Janet");
	});

	test("a repository needs a relation for each entity class among the variants", () => {
		expect(() =>
			repositoryOf({ entity: Invoice, actions: ["create"] }),
		).toThrow();
		const { People } = setup();
		expect(() =>
			repositoryOf({
				entity: Invoice,
				relations: [People],
				actions: ["create"],
			}),
		).toThrow();
	});
});
