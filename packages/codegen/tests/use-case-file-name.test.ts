import { describe, expect, test } from "bun:test";
import { useCaseFileOf } from "../src/use-case-files";

/** The two regular expressions the file name of a use case used before, kept to compare. */
const before = (text: string) =>
	`${text
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase()}.use-case.ts`;

const NAMES = [
	"RegisterUser",
	"changePassword",
	"HTTPServer",
	"getURLs",
	"getURLsFast",
	"ABC",
	"ABCdef",
	"AbC",
	"aBC",
	"XMLHttpRequest",
	"IOError",
	"v2Api",
	"Api2Go",
	"OAuth2Login",
	"S3Bucket",
	"user_ID",
	"snake_case_Name",
	"A",
	"a",
	"",
	"1A",
	"A1b",
	"ÉtéFoo",
	"fooÉBar",
	"--A--b",
	"ID",
	"IDs",
	"userIDsList",
];

describe("the file name of a use case", () => {
	test("gives the names it gave before", () => {
		for (const name of NAMES) expect(useCaseFileOf(name)).toBe(before(name));
	});

	test("gives the names it gave before, for many generated ones", () => {
		const alphabet = "aAbBzZ09_-é ";
		let seed = 7;
		const next = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed;
		};
		for (let count = 0; count < 5000; count++) {
			let name = "";
			const length = next() % 14;
			for (let index = 0; index < length; index++) {
				name += alphabet[next() % alphabet.length];
			}
			expect(useCaseFileOf(name)).toBe(before(name));
		}
	});

	test("a long run of capitals is handled in linear time", () => {
		const start = performance.now();
		useCaseFileOf(`${"A".repeat(100_000)}a`);
		useCaseFileOf("A".repeat(100_000));
		expect(performance.now() - start).toBeLessThan(200);
	});
});
