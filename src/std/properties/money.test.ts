import { describe, expect, test } from "bun:test";
import { toOpenAPI } from "../../core/openapi/openapi";
import { propertyLineageOf } from "../../core/property/lineage";
import { blueprintOf } from "../blueprint";
import { InvalidMoneyOptions } from "./exceptions";
import { currencyDecimals, moneyOf } from "./money";

/** The value of a parse that must succeed. */
function parsedValue<Value>(
	result: { readonly value: Value } | { readonly issues: readonly unknown[] },
): Value {
	if ("issues" in result) throw new Error(JSON.stringify(result.issues));
	return result.value;
}

const issuesOf = (result: { issues?: readonly unknown[] }) =>
	(result.issues ?? []).map((issue) => {
		const { code, path, message } = issue as {
			code: string;
			path: readonly (string | number)[];
			message: string;
		};
		return [code, path.join("."), message];
	});

describe("moneyOf with one currency", () => {
	const Price = moneyOf({ currency: "BRL" });

	test("holds the integer of minor units alone", () => {
		const price = new Price(1999);
		expect(price.value).toBe(1999);
		const typed: number = price.value;
		expect(typed).toBe(1999);
		expect(parsedValue(Price.safeParse(-5))).toBe(-5);
		expect(Price.demo().value).toBe(0);
	});

	test("rejects what is not an integer, with invalid_value", () => {
		for (const value of [19.99, "1999", { amount: 1, currency: "BRL" }]) {
			const { issues } = Price.safeParse(value);
			expect(issues?.map((issue) => issue.code)).toEqual(["invalid_value"]);
		}
	});

	test("keeps an amount a safe integer", () => {
		expect(parsedValue(Price.safeParse(Number.MAX_SAFE_INTEGER))).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		expect(Price.safeParse(2 ** 53).issues?.[0]?.code).toBe("invalid_value");
	});

	test("is an integer in its schema, documented with its currency", () => {
		expect(Price.type.schema.type.Type()).toMatchObject({
			type: "integer",
			description:
				"An amount of BRL, as an integer of minor units (2 decimals).",
		});
		expect(moneyOf({ currency: "JPY" }).type.schema.type.Type()).toMatchObject({
			description: expect.stringContaining("(0 decimals)"),
		});
	});
});

describe("moneyOf with a list of currencies, or none", () => {
	test("holds { amount, currency }, one of the list", () => {
		const Total = moneyOf({ currency: ["BRL", "USD"] });
		const total = new Total({ amount: 1999, currency: "USD" });
		const typed: { readonly amount: number; readonly currency: "BRL" | "USD" } =
			total.value;
		expect(typed).toEqual({ amount: 1999, currency: "USD" });
		expect(Total.demo().value).toEqual({ amount: 0, currency: "BRL" });
		expect(issuesOf(Total.safeParse({ amount: 1, currency: "EUR" }))).toEqual([
			[
				"invalid_value",
				"currency",
				"must be equal to one of the allowed values",
			],
		]);
	});

	test("takes any ISO 4217 code by its form without a list", () => {
		const Amount = moneyOf();
		expect(
			parsedValue(Amount.safeParse({ amount: 500, currency: "JPY" })),
		).toEqual({
			amount: 500,
			currency: "JPY",
		});
		expect(Amount.demo().value).toEqual({ amount: 0, currency: "USD" });
		for (const currency of ["brl", "BR", "BRLX", 986]) {
			expect(
				Amount.safeParse({ amount: 1, currency }).issues?.map(
					(issue) => issue.code,
				),
			).toEqual(["invalid_value"]);
		}
	});

	test("rejects a value that is not { amount, currency }, at its key", () => {
		const Order = blueprintOf((ctx) => ({ total: ctx.money() }));
		expect(
			issuesOf(Order.safeParse({ total: { amount: 1.5, currency: "BRL" } })),
		).toEqual([["invalid_value", "total.amount", "must be integer"]]);
		expect(
			Order.safeParse({ total: { amount: 1 } }).issues?.map((issue) => [
				issue.code,
				issue.path.join("."),
			]),
		).toEqual([["invalid_value", "total"]]);
		expect(
			Order.safeParse({ total: { amount: 1, currency: "BRL", cents: 1 } })
				.issues?.length,
		).toBeGreaterThan(0);
		expect(
			Order.safeParse({ total: 1999 }).issues?.map((issue) => issue.code),
		).toEqual(["invalid_value"]);
	});
});

describe("bounds", () => {
	test("min and max are in minor units, nonNegative rejects below zero", () => {
		const Fee = moneyOf({ currency: "BRL", min: 100, max: 10_000 });
		expect(parsedValue(Fee.safeParse(100))).toBe(100);
		expect(Fee.demo().value).toBe(100);
		expect(issuesOf(Fee.safeParse(99))).toEqual([
			["invalid_value", "", "must be >= 100"],
		]);
		expect(issuesOf(Fee.safeParse(10_001))).toEqual([
			["invalid_value", "", "must be <= 10000"],
		]);
		const Balance = moneyOf({ nonNegative: true });
		expect(
			issuesOf(Balance.safeParse({ amount: -1, currency: "BRL" })),
		).toEqual([["invalid_value", "amount", "must be >= 0"]]);
		expect(
			parsedValue(Balance.safeParse({ amount: 0, currency: "BRL" })),
		).toEqual({
			amount: 0,
			currency: "BRL",
		});
	});

	test("nonNegative keeps the higher of the two lower bounds", () => {
		expect(
			moneyOf({ currency: "BRL", min: -10, nonNegative: true }).safeParse(-1)
				.issues?.[0]?.message,
		).toBe("must be >= 0");
		expect(moneyOf({ currency: "BRL", max: -1 }).demo().value).toBe(-1);
	});
});

describe("invalid options", () => {
	test.each([
		[{ currency: "brl" }, "ISO 4217"],
		[{ currency: "R$" }, "ISO 4217"],
		[{ currency: [] }, "non-empty list"],
		[{ currency: ["BRL", "usd"] }, "non-empty list"],
		[{ currency: ["BRL", "BRL"] }, "each code once"],
		[{ min: 1.5 }, '"min"'],
		[{ max: 2 ** 53 }, '"max"'],
		[{ min: 10, max: 1 }, "no amount is accepted"],
		[{ max: -1, nonNegative: true }, "no amount is accepted"],
		[{ nonNegative: "yes" }, '"nonNegative"'],
		[{ currency: "BRL", optional: true }, "optionalOf(moneyOf(...))"],
	])("%j throws InvalidMoneyOptions", (options, reason) => {
		expect(() => moneyOf(options as never)).toThrow(InvalidMoneyOptions);
		expect(() => moneyOf(options as never)).toThrow(reason);
	});
});

describe("currencyDecimals", () => {
	test("gives the decimals of ISO 4217: 2 unless listed", () => {
		expect(currencyDecimals("BRL")).toBe(2);
		expect(currencyDecimals("USD")).toBe(2);
		expect(currencyDecimals("JPY")).toBe(0);
		expect(currencyDecimals("KRW")).toBe(0);
		expect(currencyDecimals("BHD")).toBe(3);
		expect(currencyDecimals("KWD")).toBe(3);
		expect(currencyDecimals("CLF")).toBe(4);
		expect(currencyDecimals("toString")).toBe(2);
	});
});

describe("in a blueprint", () => {
	test("ctx.money makes the field, optional with ctx.optionalOf", () => {
		const Product = blueprintOf((ctx) => ({
			price: ctx.money({ currency: "BRL", nonNegative: true }),
			discount: ctx.optionalOf(ctx.money({ currency: "BRL" })),
			prices: ctx.listOf(ctx.money({ currency: ["BRL", "USD"] })),
		}));
		const parsed = Product.safeParse({
			price: 1999,
			prices: [{ amount: 500, currency: "USD" }],
		});
		expect(parsedValue(parsed)).toEqual({
			price: 1999,
			prices: [{ amount: 500, currency: "USD" }],
		});
		const price: number | undefined = parsedValue(parsed).price;
		expect(price).toBe(1999);
		expect(
			Product.safeParse({ price: -1, prices: [] }).issues?.map((issue) => [
				issue.code,
				issue.path.join("."),
			]),
		).toEqual([["invalid_value", "price"]]);
	});

	test("documents the integer, or the object, in OpenAPI", () => {
		const Product = blueprintOf((ctx) => ({
			price: ctx.money({ currency: "BRL", min: 0 }),
			total: ctx.money({ currency: ["BRL", "USD"] }),
		}));
		const schema = toOpenAPI(Product) as {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(schema.properties.price).toMatchObject({
			type: "integer",
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
		});
		expect(schema.properties.total).toMatchObject({
			type: "object",
			required: ["amount", "currency"],
			additionalProperties: false,
			properties: {
				amount: { type: "integer" },
				currency: { enum: ["BRL", "USD"] },
			},
		});
	});

	test("records its lineage for describe()", () => {
		expect(
			propertyLineageOf(
				moneyOf({ currency: ["BRL"], min: 0, max: 10, name: "fee" }),
			),
		).toEqual({
			kind: "factory",
			factory: "moneyOf",
			args: { currency: ["BRL"], min: 0, max: 10, name: "fee" },
		});
		expect(propertyLineageOf(moneyOf())).toEqual({
			kind: "factory",
			factory: "moneyOf",
			args: {},
		});
	});
});
