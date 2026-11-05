import { describe, expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { Phone } from "../../std/properties/contact";
import { enumOf } from "../../std/properties/enum";
import { Id, Slug } from "../../std/properties/identity";
import {
	Integer,
	NumberProperty,
	StringProperty,
	Text,
} from "../../std/properties/primitives";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import type { BlueprintValue } from "../blueprint/types/blueprint.interface";
import { recordOf } from "../record/record";
import { InvalidPropertyValue } from "./exceptions";

describe("Property.with", () => {
	test("checks the constraints along with the property's own", () => {
		const Age = Integer.with({ min: 0, max: 150 });

		expect(new Age(30).value).toBe(30);
		expect(() => new Age(-1)).toThrow(InvalidPropertyValue);
		expect(() => new Age(151)).toThrow(InvalidPropertyValue);
		expect(() => new Age(1.5)).toThrow(InvalidPropertyValue);
		expect(Age.safeParse(200).issues?.[0]?.code).toBe("invalid_value");
		expect(Age["~standard"].validate(-1)).toHaveProperty("issues");
	});

	test("writes metadata and constraints to the schema", () => {
		const Price = NumberProperty.with({
			title: "Price",
			description: "In cents",
			examples: [1990],
			exclusiveMin: 0,
			multipleOf: 10,
			deprecated: true,
			readOnly: true,
		});

		expect(Price.type.schema.type.Type()).toMatchObject({
			type: "number",
			title: "Price",
			description: "In cents",
			examples: [1990],
			exclusiveMinimum: 0,
			multipleOf: 10,
			deprecated: true,
			readOnly: true,
		});
		expect(Price.type.schema.type.Type()).not.toHaveProperty("default");
		expect(NumberProperty.type.schema.type.Type()).not.toHaveProperty(
			"description",
		);
	});

	test("maps min and max of a string to its length", () => {
		const Code = StringProperty.with({ min: 2, max: 4, pattern: /^[A-Z]+$/ });

		expect(Code.type.schema.type.Type()).toMatchObject({
			minLength: 2,
			maxLength: 4,
			pattern: "^[A-Z]+$",
		});
		expect(new Code("AB").value).toBe("AB");
		expect(() => new Code("A")).toThrow(InvalidPropertyValue);
		expect(() => new Code("ABCDE")).toThrow(InvalidPropertyValue);
		expect(() => new Code("ab")).toThrow(InvalidPropertyValue);
	});

	test("only narrows: a looser bound is ignored, a second pattern is checked too", () => {
		expect(Text.with({ min: 0 }).type.schema.type.Type()).toMatchObject({
			minLength: 1,
		});
		expect(Text.with({ min: 3 }).type.schema.type.Type()).toMatchObject({
			minLength: 3,
		});
		expect(
			Integer.with({ max: 10 }).with({ max: 20 }).type.schema.type.Type(),
		).toMatchObject({ maximum: 10 });

		const Brazilian = Phone.with({ pattern: "^\\+55" });
		expect(new Brazilian("+55 11 99999-9999").value).toBe("+5511999999999");
		expect(() => new Brazilian("+1 202 555 0100")).toThrow(
			InvalidPropertyValue,
		);
		expect(() => new Brazilian("+55abc")).toThrow(InvalidPropertyValue);
	});

	test("keeps the handlers, flags, statics and name of the property", () => {
		const Short = Text.with({ max: 3 });
		expect(new Short("  ab  ").value).toBe("ab");
		expect(Short.name).toBe(Text.name);

		const Key = Id.with({ description: "The key" });
		expect(Key.generate()).toBeInstanceOf(Id);
		expect(new Key(Id.generate().value)).toBeInstanceOf(Id);

		const Handle = Slug.with({ max: 20 });
		expect(Handle.type.unique).toBe(true);
		expectTypeOf(Handle).toEqualTypeOf<typeof Slug>();
	});

	test("the demo value is default, or the first example", () => {
		expect(Integer.with({ min: 1, examples: [18, 21] }).demo().value).toBe(18);
		expect(
			Integer.with({ min: 1, examples: [18], default: 5 }).demo().value,
		).toBe(5);
		expect(Integer.with({ description: "x" }).demo().value).toBe(0);
		expect(() => Integer.with({ min: 1 }).demo()).toThrow(InvalidPropertyValue);
	});

	test("works on optional and enum properties", () => {
		const Score = optionalOf(Integer).with({ min: 1 });
		expect(new Score(undefined).value).toBeUndefined();
		expect(() => new Score(0)).toThrow(InvalidPropertyValue);

		const Status = enumOf(["draft", "published"]).with({
			description: "Publication state",
		});
		expect(new Status("draft").value).toBe("draft");
		expect(Status.type.schema.type.Type()).toMatchObject({
			description: "Publication state",
		});
	});

	test("takes the options of the property's kind of schema", () => {
		Integer.with({ min: 1, examples: [1] });
		StringProperty.with({ min: 1, pattern: "a" });
		// @ts-expect-error: a boolean has no bounds
		blueprintOf((ctx) => ({ flag: ctx.boolean({ min: 1 }) }));
		// @ts-expect-error: the examples of a number are numbers
		Integer.with({ examples: ["one"] });
		// @ts-expect-error: the examples of an enum are its values
		enumOf(["a", "b"]).with({ examples: ["c"] });
	});
});

describe("callable context properties", () => {
	test("ctx.<property>(options) is Property.with(options)", () => {
		const Product = blueprintOf((ctx) => ({
			name: ctx.text({ max: 80, description: "Shown in the catalog" }),
			price: ctx.number({ min: 1, examples: [1990] }),
			stock: ctx.optional.integer({ min: 0 }),
			tags: ctx.optionalOf(
				ctx.listOf(ctx.string({ max: 10 }), { maxItems: 3 }),
			),
		}));

		expect(Product.safeParse({ name: "Mug", price: 1990 })).toHaveProperty(
			"value",
		);
		expect(Product.safeParse({ name: "Mug", price: 0 }).issues).toHaveLength(1);
		expect(
			Product.safeParse({ name: "Mug", price: 1, stock: -1 }).issues,
		).toHaveLength(1);
		expect(
			Product.safeParse({ name: "Mug", price: 1, tags: ["far too long"] })
				.issues,
		).toHaveLength(1);

		expect(Product.schema.type.Type().properties).toMatchObject({
			name: { maxLength: 80, description: "Shown in the catalog" },
			price: { minimum: 1, examples: [1990] },
			stock: { minimum: 0 },
			tags: { items: { maxLength: 10 }, maxItems: 3 },
		});
		expect(Product.schema.type.Type().required).toEqual(["name", "price"]);

		expectTypeOf<BlueprintValue<typeof Product.properties>>().toEqualTypeOf<{
			name: string;
			price: number;
			stock?: number | undefined;
			tags?: string[] | undefined;
		}>();
	});

	test("used as it is, a context property is the class itself", () => {
		blueprintOf((ctx) => {
			expect(new ctx.number(1)).toBeInstanceOf(NumberProperty);
			expect(ctx.number.type).toBe(NumberProperty.type);
			expect(ctx.number.safeParse(1)).toEqual({ value: 1 });
			return {};
		});
	});

	test("blueprints, lists and optional fields store the class, not the callable", () => {
		const Product = blueprintOf((ctx) => ({
			price: ctx.number,
			sku: ctx.optional.string,
			codes: listOf(ctx.string),
			note: optionalOf(ctx.text),
		}));

		expect(Product.properties.price).toBe(NumberProperty);
		expect(Product.properties.sku).toBe(optionalOf(StringProperty));
		expect(Product.properties.codes.item).toBe(StringProperty);
		expect(Product.properties.note).toBe(optionalOf(Text));
		expectTypeOf(Product.properties.price).toEqualTypeOf<
			typeof NumberProperty
		>();
	});

	test("records keep the flags of refined properties", () => {
		const Account = recordOf(
			blueprintOf((ctx) => ({
				handle: ctx.slug({ max: 20 }),
				password: ctx.password({ description: "Hashed on save" }),
			})),
		);

		const account = new Account({
			handle: "Jane Doe",
			password:
				"$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
		});
		expect(account.handle).toBe("jane-doe");
		expect(account.toJSON().password).not.toContain("argon2");
	});
});
