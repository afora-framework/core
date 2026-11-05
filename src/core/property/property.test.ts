import { expect, test } from "bun:test";
import { type TString, Type } from "typebox";
import { Exception } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";
import { schemaOf } from "../schema/schema";
import { Demo } from "../symbols/demo";
import { State } from "../symbols/state";
import { AbstractProperty } from "./abstract-property";
import { AbstractDefineProperty } from "./define-property";
import { PropertyStates } from "./enums/property-states";
import { InvalidPropertyValue, PropertyRequired } from "./exceptions";
import { propertyOf } from "./property";
import type { IPropertyType } from "./types/property-type.interface";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
});

const Nickname = propertyOf({
	name: "nickname",
	schema: Type.String({ minLength: 3 }),
	optional: true,
});

test("accepts a valid value", () => {
	expect(new Name("abc").value).toBe("abc");
});

test("rejects a value that violates the schema", () => {
	expect(() => new Name("a")).toThrow('Invalid value for property "name"');
});

test("rejects undefined when required", () => {
	expect(() => new Name(undefined as never)).toThrow("is required");
});

test("allows undefined when optional", () => {
	expect(new Nickname(undefined).value).toBeUndefined();
	expect(() => new Nickname("a")).toThrow();
});

test("runs preHandle and afterHandle around validation", () => {
	const Trimmed = propertyOf({
		name: "trimmed",
		schema: Type.String({ minLength: 1 }),
		preHandle: (value) => value.trim(),
		afterHandle: (value) => value.toUpperCase(),
	});

	expect(new Trimmed("  ab ").value).toBe("AB");
	expect(() => new Trimmed("   ")).toThrow();
});

test("preHandle only receives values of the schema's types", () => {
	const received: unknown[] = [];
	const Trimmed = propertyOf({
		name: "trimmed",
		schema: Type.Object({ tags: Type.Array(Type.String({ minLength: 2 })) }),
		preHandle: (value) => {
			received.push(value);
			return { tags: value.tags.map((tag) => tag.trim()) };
		},
	});

	expect(new Trimmed({ tags: [" ab "] }).value).toEqual({ tags: ["ab"] });
	expect(() => new Trimmed({ tags: [1] } as never)).toThrow(
		'Invalid value for property "trimmed"',
	);
	expect(() => new Trimmed("ab" as never)).toThrow(
		'Invalid value for property "trimmed"',
	);
	expect(received).toEqual([{ tags: [" ab "] }]);
});

test("the property and its definition end in the Done state", () => {
	const name = new Name("abc");

	expect(name.definition[State]).toBe(PropertyStates.Done);
	expect(name[State]).toBe(PropertyStates.Done);
});

test("demo() uses the default value and validates it", () => {
	const Email = propertyOf({
		name: "email",
		schema: Type.String({ minLength: 3 }),
		default: "demo@example.com",
	});
	const Broken = propertyOf({
		name: "broken",
		schema: Type.String({ minLength: 3 }),
		default: "a",
	});

	expect(Email.demo().value).toBe("demo@example.com");
	expect(() => Broken.demo()).toThrow('Invalid value for property "broken"');
});

test("demo() throws when required and without default", () => {
	expect(() => Name.demo()).toThrow("is required");
	expect(Nickname.demo().value).toBeUndefined();
});

test("schema round-trips through toString/fromString", () => {
	const Schema = schemaOf("age", Type.Number({ minimum: 0 }));
	const copy = Schema.fromString(new Schema().toString());

	expect(copy.match(3)).toBe(true);
	expect(copy.match(-1)).toBe(false);
});

function raise(run: () => unknown): Exception {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error;
		throw error;
	}
	throw new Error("expected an exception");
}

test("preHandle only receives records whose values fit the schema", () => {
	const received: unknown[] = [];
	const Meta = propertyOf({
		name: "meta",
		schema: Type.Record(Type.String(), Type.String({ minLength: 1 })),
		preHandle: (value) => {
			received.push(value);
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, item.trim()]),
			);
		},
	});

	expect(new Meta({ a: " x " }).value).toEqual({ a: "x" });
	expect(
		raise(() => new Meta({ a: 1 } as never)).is(InvalidPropertyValue),
	).toBe(true);
	expect(received).toHaveLength(1);
});

test("the shape keeps patternProperties and additionalProperties", () => {
	const Pattern = propertyOf({
		name: "pattern",
		schema: Type.Unsafe<Record<string, string>>({
			type: "object",
			patternProperties: { "^x": { type: "string", minLength: 1 } },
			additionalProperties: false,
		}),
		preHandle: (value) =>
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, item.trim()]),
			),
	});

	expect(new Pattern({ x1: " a " }).value).toEqual({ x1: "a" });
	expect(raise(() => new Pattern({ y: "a" })).is(InvalidPropertyValue)).toBe(
		true,
	);
});

test("the shape follows references of a cyclic schema", () => {
	const received: unknown[] = [];
	const Node = propertyOf({
		name: "node",
		schema: Type.Cyclic(
			{
				Node: Type.Object({
					v: Type.String({ minLength: 2 }),
					next: Type.Optional(Type.Ref("Node")),
				}),
			},
			"Node",
		),
		preHandle: (value) => {
			received.push(value);
			return { ...value, v: value.v.trim() } as never;
		},
	});

	expect(new Node({ v: " ab ", next: { v: "cd" } } as never).value).toEqual({
		v: "ab",
		next: { v: "cd" },
	});
	expect(received).toHaveLength(1);
	expect(
		raise(() => new Node({ v: "ab", next: { v: 1 } } as never)).is(
			InvalidPropertyValue,
		),
	).toBe(true);
	expect(received).toHaveLength(1);
});

test("the shape of an enum keeps the types of its values", () => {
	const received: unknown[] = [];
	const Letter = propertyOf({
		name: "letter",
		schema: Type.Enum(["a", "b"]),
		preHandle: (value) => {
			received.push(value);
			return String(value).toLowerCase() as never;
		},
	});

	expect(new Letter("A" as never).value).toBe("a");
	expect(raise(() => new Letter(1 as never)).is(InvalidPropertyValue)).toBe(
		true,
	);
	expect(received).toEqual(["A"]);
});

test("an error thrown by a handler rejects the value", () => {
	const Boom = propertyOf({
		name: "boom",
		schema: Type.String(),
		preHandle: () => {
			throw new TypeError("boom");
		},
	});
	const After = propertyOf({
		name: "boom",
		schema: Type.String(),
		afterHandle: () => {
			throw new TypeError("boom");
		},
	});
	const Text = propertyOf({
		name: "boom",
		schema: Type.String(),
		preHandle: () => {
			throw "nope";
		},
	});

	for (const Property of [Boom, After]) {
		const exception = raise(() => new Property("a"));
		expect(exception.is(InvalidPropertyValue)).toBe(true);
		expect(exception.message).toBe('Invalid value for property "boom": boom');
		expect(exception.details).toEqual({ errors: ["boom"] });
		expect(exception.cause).toBeInstanceOf(TypeError);
	}
	expect(raise(() => new Text("a")).details).toEqual({ errors: ["nope"] });
});

test("an exception thrown by a handler goes up as it is", () => {
	const thrown = new PropertyRequired({ source: "x" });
	const Throws = propertyOf({
		name: "throws",
		schema: Type.String(),
		preHandle: () => {
			throw thrown;
		},
	});

	expect(raise(() => new Throws("a"))).toBe(thrown);
});

const CodeSchema = schemaOf("code", Type.String({ minLength: 2 }));
const codeType: IPropertyType<TString> = {
	[Demo]: "ab",
	name: "code",
	schema: new CodeSchema(),
};

class CodeDefinition extends AbstractDefineProperty<TString> {
	override get type(): IPropertyType<TString> {
		return codeType;
	}
}

/** A property written on the abstract classes, without `propertyOf`. */
class Code extends AbstractProperty<TString> {
	protected override createDefinition(): AbstractDefineProperty<TString> {
		return new CodeDefinition();
	}
}

test("a property extending the abstract classes keeps its value as it is", () => {
	const code = new Code(" ab ");

	expect(code.value).toBe(" ab ");
	expect(code[State]).toBe(PropertyStates.Done);
	expect(() => new Code("a")).toThrow('Invalid value for property "code"');
	expect(() => new Code(undefined as never)).toThrow("is required");
	expect(Code.demo().value).toBe("ab");
});

test("the shape of a const without type keeps the type of its value", () => {
	const received: unknown[] = [];
	const Status = propertyOf({
		name: "status",
		schema: Type.Unsafe<"draft">({ const: "draft" }),
		preHandle: (value) => {
			received.push(value);
			return String(value).toLowerCase() as never;
		},
	});

	expect(new Status("DRAFT" as never).value).toBe("draft");
	expect(raise(() => new Status(1 as never)).is(InvalidPropertyValue)).toBe(
		true,
	);
	expect(received).toEqual(["DRAFT"]);
});

class ExplodingDefinition extends CodeDefinition {
	protected override handle(): never {
		throw new TypeError("internal");
	}
}

class Exploding extends AbstractProperty<TString> {
	protected override createDefinition(): AbstractDefineProperty<TString> {
		return new ExplodingDefinition();
	}
}

test("parse turns an error that is not an Exception, from handle, into an issue", () => {
	for (const result of [
		Exploding.safeParse("abc"),
		Exploding["~standard"].validate("abc"),
	]) {
		if (!("issues" in result) || !result.issues) throw new Error("expected");
		const [issue] = result.issues as readonly Issue[];
		expect(issue?.code).toBe("invalid_value");
		expect(issue?.message).toBe('Invalid value for property "code": internal');
		expect(issue?.cause?.is(InvalidPropertyValue)).toBe(true);
		expect(issue?.cause?.cause).toBeInstanceOf(TypeError);
	}

	// `make` keeps throwing the raw error.
	expect(() => new Exploding("abc")).toThrow(TypeError);
});
