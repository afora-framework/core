import { describe, expect, test } from "bun:test";
import { blueprintOf, InvalidUrlOptions, recordOf, Url } from "../../index";

/** The value of a parse result, or `undefined` when it has issues. */
function parsedValue<Value>(
	result: { readonly value?: Value } | object,
): Value | undefined {
	return (result as { readonly value?: Value }).value;
}

/** The protocol the URL parser reads from `url`. */
function protocolOf(url: string): string {
	return new URL(url.trim()).protocol;
}

describe("SEC-13: Url protocols", () => {
	const unsafe = [
		"javascript:alert(document.cookie)",
		"JaVaScRiPt:alert(1)",
		" javascript:alert(1)",
		"\tjavascript:alert(1)",
		"\u0001javascript:alert(1)",
		"\u0000\u001fjavascript:alert(1)",
		"java\tscript:alert(1)",
		"java\nscript:alert(1)",
		"jav\r\nascript:alert(1)",
		"javascript\t:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"DATA:text/html;base64,PHNjcmlwdD4=",
		"d\tata:text/plain,x",
		"vbscript:msgbox",
		"VBScript:msgbox",
		"file:///etc/passwd",
		"FILE://localhost/etc/passwd",
		"fi\nle:///etc/passwd",
	];

	test("SEC-13: the variants parse as the four unsafe protocols", () => {
		for (const url of unsafe) {
			expect(["javascript:", "data:", "vbscript:", "file:"]).toContain(
				protocolOf(url),
			);
		}
	});

	test("SEC-13: Url rejects javascript:, data:, vbscript: and file:, however written", () => {
		for (const url of unsafe) {
			expect(Url.safeParse(url).issues).toBeDefined();
		}
	});

	test("SEC-13: Url accepts every other URL that parses", () => {
		for (const url of [
			"https://example.com/a?b=1",
			"http://localhost:3000",
			"HTTPS://EXAMPLE.COM",
			"  https://example.com  ",
			"postgres://user:pass@db:5432/app",
			"postgresql://db/app",
			"redis://localhost:6379",
			"memory://notes",
			"mailto:a@example.com",
			"ftp://example.com",
			"javascripts://example.com",
			"datas:x",
			"filed://x",
			"my-data:x",
		]) {
			expect(Url.safeParse(url).issues).toBeUndefined();
		}
		expect(parsedValue(Url.safeParse("https://example.com "))).toBe(
			"https://example.com",
		);
		expect(Url.safeParse("http//no").issues).toBeDefined();
		expect(Url.safeParse("example").issues).toBeDefined();
	});

	test("SEC-13: ctx.url rejects javascript: in a record, accepts a database URL", () => {
		const Link = recordOf(blueprintOf((ctx) => ({ href: ctx.url })));
		expect(
			Link.safeParse({ href: "javascript:alert(1)" }).issues,
		).toBeDefined();
		expect(Link.safeParse({ href: "https://a.dev" }).issues).toBeUndefined();
		expect(Link.safeParse({ href: "memory://notes" }).issues).toBeUndefined();
	});

	test("SEC-13: Url.with({ protocols }) accepts only the protocols it lists", () => {
		const Contact = Url.with({ protocols: ["https:", "mailto:"] });
		expect(Contact.safeParse("mailto:a@example.com").issues).toBeUndefined();
		expect(Contact.safeParse("https://example.com").issues).toBeUndefined();
		expect(Contact.safeParse(" HT\tTPS://example.com").issues).toBeUndefined();
		expect(Contact.safeParse("http://example.com").issues).toBeDefined();
		expect(Contact.safeParse("postgres://db").issues).toBeDefined();
		expect(Contact.safeParse("javascript:alert(1)").issues).toBeDefined();
		expect(new Contact("mailto:a@example.com")).toBeInstanceOf(Url);

		const Inline = Url.with({ protocols: ["data:"] });
		expect(Inline.safeParse("data:text/plain,x").issues).toBeUndefined();
		expect(Inline.safeParse("https://example.com").issues).toBeDefined();

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
		});

		// Other options keep the protocols of the class they narrow.
		const Short = Contact.with({ max: 50 });
		expect(Short.safeParse("mailto:a@example.com").issues).toBeUndefined();
		expect(Short.safeParse("ftp://example.com").issues).toBeDefined();
		const Bounded = Url.with({ max: 50 });
		expect(Bounded.safeParse("javascript:alert(1)").issues).toBeDefined();
		expect(Bounded.safeParse("redis://localhost").issues).toBeUndefined();
	});

	test("SEC-13: protocols must be schemes ending with a colon", () => {
		expect(() => Url.with({ protocols: ["https"] })).toThrow(InvalidUrlOptions);
		expect(() => Url.with({ protocols: [] })).toThrow(InvalidUrlOptions);
		expect(() => Url.with({ protocols: ["ja(va)script:"] })).toThrow(
			InvalidUrlOptions,
		);
	});
});
