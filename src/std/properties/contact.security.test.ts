import { describe, expect, test } from "bun:test";
import { blueprintOf, recordOf, Url } from "../../index";

/** The value of a parse result, or `undefined` when it has issues. */
function parsedValue<Value>(
	result: { readonly value?: Value } | object,
): Value | undefined {
	return (result as { readonly value?: Value }).value;
}

describe("SEC-13: Url protocols", () => {
	const dangerous = [
		"javascript:alert(document.cookie)",
		"JavaScript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"vbscript:msgbox",
		"mailto:a@example.com",
		"ftp://example.com",
		" java\tscript:alert(1)",
	];

	test("SEC-13: Url accepts http: and https: only, by default", () => {
		for (const url of dangerous) {
			expect(Url.safeParse(url).issues).toBeDefined();
		}
		for (const url of [
			"https://example.com/a?b=1",
			"http://localhost:3000",
			"HTTPS://EXAMPLE.COM",
			"  https://example.com  ",
		]) {
			expect(Url.safeParse(url).issues).toBeUndefined();
		}
		expect(parsedValue(Url.safeParse("https://example.com "))).toBe(
			"https://example.com",
		);
		expect(Url.safeParse("http//no").issues).toBeDefined();
	});

	test("SEC-13: ctx.url rejects javascript: in a record", () => {
		const Link = recordOf(blueprintOf((ctx) => ({ href: ctx.url })));
		expect(
			Link.safeParse({ href: "javascript:alert(1)" }).issues,
		).toBeDefined();
		expect(Link.safeParse({ href: "https://a.dev" }).issues).toBeUndefined();
	});

	test("SEC-13: Url.with({ protocols }) widens and narrows the protocols", () => {
		const Contact = Url.with({ protocols: ["https:", "mailto:"] });
		expect(Contact.safeParse("mailto:a@example.com").issues).toBeUndefined();
		expect(Contact.safeParse("https://example.com").issues).toBeUndefined();
		expect(Contact.safeParse("http://example.com").issues).toBeDefined();
		expect(Contact.safeParse("javascript:alert(1)").issues).toBeDefined();
		expect(new Contact("mailto:a@example.com")).toBeInstanceOf(Url);

		const Described = Url.with({
			protocols: ["ftp:"],
			description: "A mirror",
			max: 100,
		});
		expect(Described.safeParse("ftp://example.com").issues).toBeUndefined();
		expect(
			Described.safeParse(`ftp://${"a".repeat(100)}`).issues,
		).toBeDefined();
		expect(Described.type.schema.type.Type()).toMatchObject({
			description: "A mirror",
			pattern: "^(?:[fF][tT][pP]):",
		});

		// Other options keep the protocols of the class they narrow.
		const Short = Contact.with({ max: 50 });
		expect(Short.safeParse("mailto:a@example.com").issues).toBeUndefined();
		expect(Short.safeParse("javascript:alert(1)").issues).toBeDefined();
	});

	test("SEC-13: protocols must be schemes ending with a colon", () => {
		expect(() => Url.with({ protocols: ["https"] })).toThrow();
		expect(() => Url.with({ protocols: [] })).toThrow();
		expect(() => Url.with({ protocols: ["ja(va)script:"] })).toThrow();
	});
});
