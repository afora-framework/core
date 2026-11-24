import { describe, expect, test } from "bun:test";
import { Password, PlainPassword } from "../../index";

/** Whether `PlainPassword` accepts `value`. */
function plainAccepts(value: string): boolean {
	try {
		new PlainPassword(value);
		return true;
	} catch {
		return false;
	}
}

/** Whether `Password.hash` accepts `value`. */
function hashAccepts(value: string): Promise<boolean> {
	return Password.hash(value).then(
		() => true,
		() => false,
	);
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe("SEC-26: one password rule for PlainPassword and Password.hash", () => {
	const lineBreaks = ["\n", "\r", "\r\n", LINE_SEPARATOR, PARAGRAPH_SEPARATOR];
	const strong = lineBreaks.flatMap((lineBreak) => [
		`abcdef${lineBreak}A1!`,
		`A1!${lineBreak}abcdef`,
		`abc${lineBreak}DEF${lineBreak}1${lineBreak}!`,
	]);
	const weak = lineBreaks.flatMap((lineBreak) => [
		`abcdef${lineBreak}A1`,
		`abcdef${lineBreak}a1!`,
		`ABCDEF${lineBreak}A1!`,
		`abcdef${lineBreak}Ab!`,
	]);

	test("SEC-26: a strong password with line breaks is accepted by both", async () => {
		for (const value of strong) {
			expect({ value, plain: plainAccepts(value) }).toEqual({
				value,
				plain: true,
			});
			expect({ value, hash: await hashAccepts(value) }).toEqual({
				value,
				hash: true,
			});
		}
	});

	test("SEC-26: a weak password with line breaks is refused by both", async () => {
		for (const value of weak) {
			expect({ value, plain: plainAccepts(value) }).toEqual({
				value,
				plain: false,
			});
			expect({ value, hash: await hashAccepts(value) }).toEqual({
				value,
				hash: false,
			});
		}
	});
});
