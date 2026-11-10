import { describe, expect, test } from "bun:test";
import { blueprintOf, environmentOf, recordOf } from "../../../index";
import { followPath, parseReference, resolveValue } from "./references";
import { invalidStep, stepsCase } from "./steps.fixtures";

const Any = blueprintOf((ctx) => ({ out: ctx.schema }));

describe("parseReference", () => {
	test("splits the root and the path, with identifiers and indices", () => {
		expect(parseReference("$input")).toEqual({ root: "input", path: [] });
		expect(parseReference("$saved.tags.0.name")).toEqual({
			root: "saved",
			path: ["tags", "0", "name"],
		});
	});

	test("rejects what is not a reference", () => {
		for (const text of [
			"$",
			"$.a",
			"$a.",
			"$a..b",
			"$a.-1",
			"$a.01",
			"$a b",
			"$1a",
			"a",
		]) {
			expect(parseReference(text)).toBeUndefined();
		}
	});
});

describe("values", () => {
	const roots: Record<string, unknown> = {
		a: { list: [{ n: 1 }] },
		x: 1,
	};
	const lookup = ({ root, path }: { root: string; path: readonly string[] }) =>
		followPath(roots[root], path);

	test("a missing segment is undefined and never throws", () => {
		expect(resolveValue("$a.list.0.n", lookup)).toBe(1);
		expect(resolveValue("$a.list.5.n", lookup)).toBeUndefined();
		expect(resolveValue("$a.nope.deeper", lookup)).toBeUndefined();
		expect(resolveValue("$x.toFixed", lookup)).toBeUndefined();
		expect(resolveValue("$a.constructor", lookup)).toBeUndefined();
		expect(resolveValue("$a.__proto__", lookup)).toBeUndefined();
	});

	test("literals, escapes and mappings", () => {
		expect(resolveValue("plain", lookup)).toBe("plain");
		expect(resolveValue({ literal: "$5" }, lookup)).toBe("$5");
		expect(resolveValue({ literal: { a: "$a" } }, lookup)).toEqual({
			a: "$a",
		});
		expect(resolveValue({ literal: 1, other: 2 }, lookup)).toEqual({
			literal: 1,
			other: 2,
		});
		expect(
			resolveValue({ n: "$a.list.0.n", l: ["$x", 2, null] }, lookup),
		).toEqual({ n: 1, l: [1, 2, null] });
	});
});

describe("references in a use case", () => {
	const Mail = environmentOf(
		blueprintOf((ctx) => ({ FROM: ctx.string })),
		{ source: () => ({ FROM: "no-reply" }) },
	);
	const fn = () => ({ items: [{ id: "i0" }, { id: "i1" }] });
	const Case = stepsCase({
		blueprint: blueprintOf((ctx) => ({ name: ctx.string, tags: ctx.string })),
		context: blueprintOf((ctx) => ({ tenant: ctx.string })),
		dependencies: { mail: Mail },
		response: Any,
		steps: [
			{ run: "pack", fn, as: "pack" },
			{
				return: {
					out: {
						input: "$input.name",
						context: "$context.tenant",
						env: "$env.mail.FROM",
						index: "$pack.items.1.id",
						escaped: { literal: "$input.name" },
						list: ["$input.name", 3, true, null],
						whole: "$input",
					},
				},
			},
		],
	});

	test("resolve roots, paths, indices, escapes and mappings", async () => {
		const input = { name: "Ana", tags: "t" };
		const result = (await new Case(input, {
			context: { tenant: "acme" },
		}).execute()) as { out: Record<string, unknown> };
		expect(result.out).toEqual({
			input: "Ana",
			context: "acme",
			env: "no-reply",
			index: "i1",
			escaped: "$input.name",
			list: ["Ana", 3, true, null],
			whole: input,
		});
	});

	test("declaration rules", () => {
		const declare = (value: unknown, extra: object = {}) =>
			invalidStep(() =>
				stepsCase({
					dependencies: { mail: Mail, other: Case },
					...extra,
					steps: [{ return: value }],
				}),
			);
		expect(declare("$nothing").code).toBe("unbound_reference");
		expect(declare("$input.missing")).toMatchObject({
			code: "unknown_key",
			index: 0,
		});
		expect(declare("$context.tenant").code).toBe("invalid_reference");
		expect(
			declare("$context.nope", {
				context: blueprintOf((ctx) => ({ tenant: ctx.string })),
			}).code,
		).toBe("unknown_key");
		expect(declare("$env").code).toBe("unknown_dependency");
		expect(declare("$env.other.x").code).toBe("unknown_dependency");
		expect(declare("$env.unknown.x").code).toBe("unknown_dependency");
		expect(declare("$literal").code).toBe("invalid_reference");
		expect(declare("$5").code).toBe("invalid_reference");
		expect(declare({ a: ["$bad."] }).code).toBe("invalid_reference");
		expect(declare({ a: () => 1 }).code).toBe("invalid_value");
		expect(declare({ a: undefined }).code).toBe("invalid_value");
		expect(declare({ a: new Date() }).code).toBe("invalid_value");
	});

	test("paths of input and context are checked at any depth", () => {
		class Author extends recordOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
		) {
			get initial(): string {
				return this.name.charAt(0);
			}
		}
		const Address = blueprintOf((ctx) => ({ zip: ctx.string }));
		const Deep = blueprintOf((ctx) => ({
			name: ctx.string,
			address: Address,
			tags: ctx.list.string,
			author: Author,
			out: ctx.schema,
		}));
		const declare =
			(value: string, extra: object = {}) =>
			() =>
				stepsCase({ blueprint: Deep, ...extra, steps: [{ return: value }] });
		for (const valid of [
			"$input.address.zip",
			"$input.tags.0",
			"$input.author.name",
			"$input.author.initial.anything",
			"$input.out.anything",
		]) {
			expect(declare(valid)).not.toThrow();
		}
		for (const [invalid, segment] of [
			["$input.name.deeper", "deeper"],
			["$input.address.zipp", "zipp"],
			["$input.tags.first", "first"],
			["$input.tags.0.x", "x"],
			["$input.author.nope", "nope"],
		] as const) {
			expect(invalidStep(declare(invalid))).toMatchObject({
				code: "unknown_key",
				reason: `"${invalid}" names "${segment}", which the input does not declare.`,
			});
		}
		expect(
			invalidStep(declare("$context.address.zipp", { context: Deep })).code,
		).toBe("unknown_key");
	});

	test("as must be an identifier, not reserved and not repeated", () => {
		const declare = (as: unknown) =>
			invalidStep(() =>
				stepsCase({ steps: [{ run: "a", fn, as }, { return: {} }] }),
			);
		for (const reserved of ["input", "context", "env", "literal"]) {
			expect(declare(reserved).code).toBe("invalid_step_name");
		}
		expect(declare("a-b").code).toBe("invalid_step_name");
		expect(declare(3).code).toBe("invalid_step_name");
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [
						{ run: "a", fn, as: "x" },
						{ run: "b", fn, as: "x" },
						{ return: {} },
					],
				}),
			),
		).toMatchObject({ index: 1, code: "invalid_step_name" });
	});

	test("a step cannot reference its own result or a later one", () => {
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [
						{ run: "a", fn, args: ["$later"], as: "now" },
						{ run: "b", fn, as: "later" },
						{ return: {} },
					],
				}),
			).code,
		).toBe("unbound_reference");
		expect(
			invalidStep(() =>
				stepsCase({
					steps: [{ run: "a", fn, args: ["$me"], as: "me" }, { return: {} }],
				}),
			).code,
		).toBe("unbound_reference");
	});
});
