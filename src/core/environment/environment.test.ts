import { expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	type EnvironmentValue,
	Exception,
	ExceptionLayers,
	environmentOf,
	InvalidEnvironment,
} from "../../index";
import { isEnvironment } from "./environment";

const Variables = blueprintOf((ctx) => ({
	DATABASE_URL: ctx.url,
	REGION: ctx.optional.string,
}));

test("reads only the declared variables, validated", () => {
	const environment = environmentOf(Variables, {
		source: () => ({ DATABASE_URL: "https://db.example.com", PATH: "/bin" }),
	});
	expect(isEnvironment(environment)).toBe(true);
	expect(environment.load()).toEqual({
		DATABASE_URL: "https://db.example.com",
	});
	expectTypeOf<EnvironmentValue<typeof environment>>().toEqualTypeOf<
		Readonly<{ DATABASE_URL: string; REGION?: string }>
	>();
});

test("reads the source once, on the first load", () => {
	let reads = 0;
	const environment = environmentOf(Variables, {
		source: () => {
			reads++;
			return { DATABASE_URL: "https://db.example.com" };
		},
	});
	expect(reads).toBe(0);
	expect(environment.load()).toBe(environment.load());
	expect(reads).toBe(1);
});

test("reads process.env by default", () => {
	process.env.AFORA_TEST_REGION = "sa-east-1";
	const environment = environmentOf(
		blueprintOf((ctx) => ({ AFORA_TEST_REGION: ctx.string })),
	);
	expect(environment.load().AFORA_TEST_REGION).toBe("sa-east-1");
	delete process.env.AFORA_TEST_REGION;
});

test("a missing or rejected variable throws InvalidEnvironment", () => {
	const environment = environmentOf(Variables, {
		source: () => ({ REGION: "sa-east-1" }),
	});
	try {
		environment.load();
		throw new Error("expected InvalidEnvironment");
	} catch (error) {
		expect(error).toBeInstanceOf(Exception);
		expect((error as Exception).is(InvalidEnvironment)).toBe(true);
		expect((error as Exception).layer).toBe(ExceptionLayers.Environment);
		expect((error as Exception).details).toEqual({ keys: ["DATABASE_URL"] });
	}
});

test("requires a blueprint", () => {
	// @ts-expect-error not a blueprint
	expect(() => environmentOf({})).toThrow(TypeError);
});

test("converts variables to the number or boolean their property takes", () => {
	const environment = environmentOf(
		blueprintOf((ctx) => ({
			PORT: ctx.integer,
			RATIO: ctx.number,
			DEBUG: ctx.boolean,
			CACHE: ctx.optional.boolean,
			LEVEL: ctx.enumOf([1, 2, 3]),
			VERSION: ctx.string,
		})),
		{
			source: () => ({
				PORT: "3000",
				RATIO: " 0.5 ",
				DEBUG: "true",
				CACHE: "false",
				LEVEL: "2",
				VERSION: "10",
			}),
		},
	);
	expect(environment.load()).toEqual({
		PORT: 3000,
		RATIO: 0.5,
		DEBUG: true,
		CACHE: false,
		LEVEL: 2,
		VERSION: "10",
	});
	expectTypeOf(environment.load().PORT).toEqualTypeOf<number>();
	expectTypeOf(environment.load().DEBUG).toEqualTypeOf<boolean>();
});

test("a variable that does not convert is rejected", () => {
	const environment = environmentOf(
		blueprintOf((ctx) => ({
			PORT: ctx.integer,
			DEBUG: ctx.boolean,
			LEVEL: ctx.enumOf([1, 2, 3]),
		})),
		{ source: () => ({ PORT: "3000.5", DEBUG: "yes", LEVEL: "" }) },
	);
	expect(() => environment.load()).toThrow(InvalidEnvironment);
	try {
		environment.load();
	} catch (error) {
		expect((error as Exception).details).toEqual({
			keys: ["PORT", "DEBUG", "LEVEL"],
		});
	}
});
