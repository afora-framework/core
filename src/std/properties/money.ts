import {
	type TEnum,
	type TInteger,
	type TObject,
	type TString,
	Type,
} from "typebox";
import { recordPropertyLineage } from "../../core/property/lineage";
import { type PropertyClass, propertyOf } from "../../core/property/property";
import { InvalidMoneyOptions } from "./exceptions";

/** An amount of money that carries its currency, as `moneyOf()` holds it. */
export interface MoneyValue<Currency extends string = string> {
	/** The amount, as an integer of minor units of `currency` (cents for `"BRL"`). */
	readonly amount: number;
	/** The ISO 4217 code of the currency, three upper-case letters. */
	readonly currency: Currency;
}

/**
 * What `moneyOf` takes. An optional amount is `optionalOf(moneyOf(...))`
 * (`ctx.optionalOf(ctx.money(...))` in a blueprint).
 */
export interface MoneyOptions<
	Currencies extends string | readonly string[] = string | readonly string[],
> {
	/**
	 * One ISO 4217 code (`"BRL"`) for an amount of that currency, held as the
	 * integer of minor units alone; a list of codes for an amount that carries
	 * one of them (`{ amount, currency }`). Absent: an amount that carries any
	 * code of three upper-case letters.
	 */
	readonly currency?: Currencies;
	/** The smallest amount accepted, in minor units. */
	readonly min?: number;
	/** The largest amount accepted, in minor units. */
	readonly max?: number;
	/** Rejects an amount below zero. */
	readonly nonNegative?: boolean;
	readonly name?: string;
}

/** The schema of an amount that carries its currency. */
export type TMoney = TObject<{
	amount: TInteger;
	currency: TString | TEnum<string[]>;
}>;

/** An ISO 4217 code, checked by its form only. */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * The ISO 4217 codes whose minor unit is not a hundredth: every other code
 * has 2 decimals. A small table, so that no list of every currency ships.
 */
const DECIMALS: Readonly<Record<string, number>> = Object.freeze({
	BIF: 0,
	CLP: 0,
	DJF: 0,
	GNF: 0,
	ISK: 0,
	JPY: 0,
	KMF: 0,
	KRW: 0,
	PYG: 0,
	RWF: 0,
	UGX: 0,
	UYI: 0,
	VND: 0,
	VUV: 0,
	XAF: 0,
	XOF: 0,
	XPF: 0,
	BHD: 3,
	IQD: 3,
	JOD: 3,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	TND: 3,
	CLF: 4,
	UYW: 4,
});

/**
 * The decimals of `currency` in ISO 4217, what its minor unit is: 0 for
 * `"JPY"` (an amount of 500 is ¥500), 3 for `"BHD"`, 2 for `"BRL"` and
 * any code not among the few with another number.
 *
 * @example
 * ```ts
 * import { currencyDecimals } from "@afora/core";
 *
 * currencyDecimals("BRL"); // 2: an amount of 1999 is 19.99
 * currencyDecimals("JPY"); // 0
 * ```
 */
export function currencyDecimals(currency: string): number {
	return Object.hasOwn(DECIMALS, currency) ? (DECIMALS[currency] as number) : 2;
}

function invalidOptions(source: string, reason: string): never {
	throw new InvalidMoneyOptions({ source, details: { reason } });
}

/** The bounds of an amount, from the options; an amount stays a safe integer. */
function boundsOf(
	source: string,
	{ min, max, nonNegative }: MoneyOptions,
): { readonly minimum: number; readonly maximum: number } {
	for (const [key, value] of [
		["min", min],
		["max", max],
	] as const) {
		if (value !== undefined && !Number.isSafeInteger(value)) {
			invalidOptions(
				source,
				`expected "${key}" to be an integer of minor units.`,
			);
		}
	}
	if (nonNegative !== undefined && typeof nonNegative !== "boolean") {
		invalidOptions(source, 'expected "nonNegative" to be a boolean.');
	}
	const minimum = Math.max(
		min ?? -Number.MAX_SAFE_INTEGER,
		nonNegative ? 0 : -Number.MAX_SAFE_INTEGER,
	);
	const maximum = max ?? Number.MAX_SAFE_INTEGER;
	if (minimum > maximum) {
		invalidOptions(
			source,
			`no amount is accepted: the smallest is ${minimum}, the largest ${maximum}.`,
		);
	}
	return { minimum, maximum };
}

/** The currencies of the options, checked: one code, a list of codes, or any. */
function currenciesOf(
	source: string,
	currency: unknown,
): string | readonly string[] | undefined {
	if (currency === undefined) return undefined;
	if (typeof currency === "string") {
		if (!CURRENCY.test(currency)) {
			invalidOptions(
				source,
				`expected "currency" to be an ISO 4217 code of three upper-case letters, as "BRL", not ${JSON.stringify(currency)}.`,
			);
		}
		return currency;
	}
	if (
		!Array.isArray(currency) ||
		currency.length === 0 ||
		currency.some((code) => typeof code !== "string" || !CURRENCY.test(code))
	) {
		invalidOptions(
			source,
			'expected "currency" to be an ISO 4217 code, as "BRL", or a non-empty list of them.',
		);
	}
	if (new Set(currency).size !== currency.length) {
		invalidOptions(source, 'expected "currency" to list each code once.');
	}
	return Object.freeze([...(currency as string[])]);
}

/**
 * An amount of money, held as an integer of minor units (cents for `"BRL"`,
 * yen for `"JPY"`), so no floating point ever rounds it. With one
 * `currency`, the value is the integer alone (`1999` for R$ 19.99); with a
 * list of currencies, or none, it is `{ amount, currency }`, where
 * `currency` is one of the list, or any ISO 4217 code by its form (three
 * upper-case letters). `min` and `max` bound the amount, in minor units,
 * and `nonNegative` rejects one below zero; an amount is always a safe
 * integer. `optionalOf(moneyOf(...))` is an optional amount. Options that
 * are not valid throw `InvalidMoneyOptions` when the property is declared.
 * `currencyDecimals` gives the decimals of a currency.
 * No arithmetic, rounding or exchange: the property checks a value.
 *
 * @example
 * ```ts
 * import { blueprintOf, moneyOf } from "@afora/core";
 *
 * const Price = moneyOf({ currency: "BRL", nonNegative: true });
 * new Price(1999).value; // 1999, R$ 19.99
 *
 * const Order = blueprintOf((ctx) => ({
 * 	total: ctx.money({ currency: ["BRL", "USD"] }),
 * }));
 * Order.safeParse({ total: { amount: 1999, currency: "USD" } });
 * // { value: { total: { amount: 1999, currency: "USD" } } }
 * ```
 */
export function moneyOf<const Currency extends string>(
	options: MoneyOptions<Currency> & { readonly currency: Currency },
): PropertyClass<TInteger, number>;
export function moneyOf<const Currency extends string = string>(
	options?: MoneyOptions<readonly Currency[]>,
): PropertyClass<TMoney, MoneyValue<Currency>>;
export function moneyOf(
	options: MoneyOptions = {},
): PropertyClass<TInteger, number> | PropertyClass<TMoney, MoneyValue> {
	const { name = "money" } = options;
	if (Object.hasOwn(options, "optional")) {
		invalidOptions(
			name,
			'"optional" is not an option: an optional amount is optionalOf(moneyOf(...)).',
		);
	}
	const currency = currenciesOf(name, options.currency);
	const { minimum, maximum } = boundsOf(name, options);
	const fixed = typeof currency === "string";
	const amount = Type.Integer({
		minimum,
		maximum,
		description: fixed
			? `An amount of ${currency}, as an integer of minor units (${currencyDecimals(currency)} decimals).`
			: "The amount, as an integer of minor units of the currency.",
	});
	const demoAmount = Math.min(Math.max(0, minimum), maximum);
	const Property = fixed
		? propertyOf({ name, schema: amount, default: demoAmount })
		: propertyOf({
				name,
				schema: Type.Object(
					{
						amount,
						currency:
							currency === undefined
								? Type.String({
										pattern: CURRENCY.source,
										description: 'An ISO 4217 code, as "BRL".',
									})
								: Type.Enum([...currency], {
										description: "An ISO 4217 code.",
									}),
					},
					{
						additionalProperties: false,
						description:
							"An amount of money: an integer of minor units of its currency.",
					},
				),
				default: { amount: demoAmount, currency: currency?.[0] ?? "USD" },
			});
	recordPropertyLineage(Property, {
		kind: "factory",
		factory: "moneyOf",
		args: Object.freeze({
			...(currency === undefined ? {} : { currency }),
			...(options.min === undefined ? {} : { min: options.min }),
			...(options.max === undefined ? {} : { max: options.max }),
			...(options.nonNegative ? { nonNegative: true } : {}),
			...(name === "money" ? {} : { name }),
		}),
	});
	return Property as
		| PropertyClass<TInteger, number>
		| PropertyClass<TMoney, MoneyValue>;
}
