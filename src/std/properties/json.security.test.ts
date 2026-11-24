import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
	blueprintOf,
	checkJsonSchema,
	InvalidJsonData,
	InvalidJsonSchema,
	JsonProperty,
	jsonOf,
	jsonSchemaIssues,
	recordOf,
} from "../../index";

/** `depth` arrays, one inside the other, as `JSON.parse` gives them. */
function nested(depth: number): unknown {
	return JSON.parse("[".repeat(depth) + "]".repeat(depth));
}

describe("SEC-04: deeply nested JSON", () => {
	const Doc = recordOf(
		blueprintOf((ctx) => ({ title: ctx.text, data: ctx.json })),
	);

	test("SEC-04: a body nested 20000 deep is rejected in linear time", () => {
		const data = nested(20000);
		const started = performance.now();
		const result = Doc.safeParse({ title: "t", data });
		const elapsed = performance.now() - started;
		expect(result.issues?.[0]?.message).toContain("is nested too deeply");
		expect(result.issues?.[0]?.path?.[0]).toBe("data");
		expect(elapsed).toBeLessThan(100);
	});

	test("SEC-04: JsonProperty and jsonSchemaIssues cap the depth too", () => {
		const data = nested(20000);
		let started = performance.now();
		expect(JsonProperty.safeParse(data).issues?.[0]?.message).toContain(
			"is nested too deeply",
		);
		expect(performance.now() - started).toBeLessThan(100);

		started = performance.now();
		const issues = jsonSchemaIssues({ type: "array" }, data);
		expect(issues[0]?.message).toBe("is nested too deeply");
		expect(issues[0]?.code).toBe("invalid_value");
		expect(() => checkJsonSchema({ type: "array" }, data)).toThrow(
			InvalidJsonData,
		);
		expect(performance.now() - started).toBeLessThan(100);
	});

	test("SEC-04: a value nested 1000 deep is accepted, 1001 is not", () => {
		expect(JsonProperty.safeParse(nested(1000)).issues).toBeUndefined();
		expect(Doc.safeParse({ title: "t", data: nested(999) }).issues).toBe(
			undefined,
		);
		expect(JsonProperty.safeParse(nested(1001)).issues).toBeDefined();
		const deepObject = JSON.parse(
			`${'{"a":'.repeat(1001)}1${"}".repeat(1001)}`,
		);
		expect(JsonProperty.safeParse(deepObject).issues?.[0]?.message).toContain(
			"is nested too deeply",
		);
	});

	test("SEC-04: cycles are still circular, shared values are not", () => {
		const cycle: Record<string, unknown> = { a: [1] };
		(cycle.a as unknown[]).push(cycle);
		expect(JsonProperty.safeParse(cycle).issues?.[0]?.message).toContain(
			"/a/1: is circular",
		);
		const shared = { x: 1 };
		expect(JsonProperty.safeParse([shared, shared, { shared }]).issues).toBe(
			undefined,
		);
	});

	test("SEC-04: jsonOf caps the depth before its schema walks the value", () => {
		const Any = jsonOf({ schema: Type.Array(Type.Any()) });
		expect(Any.safeParse(nested(5000)).issues?.[0]?.message).toContain(
			"is nested too deeply",
		);
	});
});

describe("SEC-28: deep values of a recursive JSON schema", () => {
	const Node = Type.Cyclic(
		{ Node: Type.Object({ children: Type.Array(Type.Ref("Node")) }) },
		"Node",
	);
	const Tree = jsonOf({ schema: Node, name: "tree" });
	const Doc = recordOf(blueprintOf((ctx) => ({ title: ctx.text, tree: Tree })));
	const deep = (depth: number): unknown =>
		JSON.parse(
			`${'{"children":['.repeat(depth)}{"children":[]}${"]}".repeat(depth)}`,
		);

	test("SEC-28: the depth is capped before the schema is checked", () => {
		for (const depth of [5000, 20000, 100000]) {
			const value = deep(depth);
			expect(Tree.safeParse(value).issues?.[0]?.message).toContain(
				"is nested too deeply",
			);
			const issue = Doc.safeParse({ title: "t", tree: value }).issues?.[0];
			expect(issue?.message).toContain("is nested too deeply");
			expect(issue?.path).toEqual(["tree"]);
		}
		expect(Tree.safeParse(deep(10)).issues).toBeUndefined();
	});
});

describe("SEC-51: cost of checking against a schema known at runtime", () => {
	function fanOut(count: number, keyword: "allOf" | "anyOf"): unknown {
		const defs: Record<string, unknown> = { d0: { type: "number" } };
		for (let index = 1; index <= count; index++) {
			const ref = { $ref: `#/$defs/d${index - 1}` };
			defs[`d${index}`] = { [keyword]: [ref, { ...ref }] };
		}
		return { $defs: defs, $ref: `#/$defs/d${count}` };
	}
	const refused: readonly unknown[] = [
		fanOut(24, "allOf"),
		fanOut(24, "anyOf"),
		{ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" },
		{ type: "string", pattern: "^(a+)+$" },
		{ type: "string", pattern: "^(.*a){12}$" },
		JSON.parse(`${'{"items":'.repeat(20000)}{}${"}".repeat(20000)}`),
	];

	test("SEC-51: jsonSchemaIssues and checkJsonSchema throw InvalidJsonSchema, quickly", () => {
		for (const schema of refused) {
			const started = performance.now();
			expect(() => jsonSchemaIssues(schema, `${"a".repeat(30)}!`)).toThrow(
				InvalidJsonSchema,
			);
			expect(() => checkJsonSchema(schema, 1)).toThrow(InvalidJsonSchema);
			expect(performance.now() - started).toBeLessThan(100);
		}
	});

	test("SEC-51: a schema with references of ordinary cost is still checked", () => {
		const schema = {
			$defs: { name: { type: "string", minLength: 1 } },
			type: "object",
			properties: {
				title: { $ref: "#/$defs/name" },
				authors: { type: "array", items: { $ref: "#/$defs/name" } },
			},
			required: ["title"],
		};
		expect(jsonSchemaIssues(schema, { title: "t", authors: ["a"] })).toEqual(
			[],
		);
		expect(jsonSchemaIssues(schema, { title: "" })[0]?.path).toEqual(["title"]);
		expect(checkJsonSchema(schema, { title: "t" })).toEqual({ title: "t" });
	});
});
