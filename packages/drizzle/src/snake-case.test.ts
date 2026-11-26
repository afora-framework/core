import { describe, expect, test } from "bun:test";
import { snakeCaseOf } from "./migrate";

const reference = (key: string): string =>
	(key.match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [])
		.map((word) => word.toLowerCase())
		.join("_");

describe("snakeCaseOf", () => {
	test("names columns as Drizzle's snake_case casing does", () => {
		expect(snakeCaseOf("createdAt")).toBe("created_at");
		expect(snakeCaseOf("HTMLParser")).toBe("html_parser");
		expect(snakeCaseOf("userID")).toBe("user_id");
		expect(snakeCaseOf("A1")).toBe("a_1");
		expect(snakeCaseOf("schema_version")).toBe("schema_version");
		expect(snakeCaseOf("page2Of3")).toBe("page2_of3");
	});

	test("gives the words of the reference pattern", () => {
		const alphabet = "aAbB1_-Zz9 ";
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let round = 0; round < 20000; round++) {
			let key = "";
			const length = Math.floor(random() * 10);
			for (let index = 0; index < length; index++)
				key += alphabet[Math.floor(random() * alphabet.length)];
			expect(snakeCaseOf(key)).toBe(reference(key));
		}
	});

	test("stays linear on a long run of capitals", () => {
		const key = `${"A".repeat(200_000)}!`;
		const started = performance.now();
		expect(snakeCaseOf(key)).toBe("a".repeat(200_000));
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
