import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { blueprintPluginOf } from "../blueprint/blueprint-plugin";
import { ReservedBlueprintKey } from "../blueprint/exceptions";
import { InvalidPropertyValue, PropertyRequired } from "../property/exceptions";
import { propertyOf } from "../property/property";
import { ExceptionLayers } from "./enums/exception-layers";
import { Exception, exceptionOf, UNEXPECTED_ERROR } from "./exception";
import { guard } from "./guard";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
});

const UserNotCreated = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserNotCreated",
	message: "Could not create the user.",
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

test("knows its layer, name and source", () => {
	const exception = raise(() => new Name("a"));

	expect(exception).toBeInstanceOf(InvalidPropertyValue);
	expect(exception).toBeInstanceOf(Error);
	expect(exception.layer).toBe(ExceptionLayers.Property);
	expect(exception.name).toBe("InvalidPropertyValue");
	expect(exception.source).toBe("name");
	expect(exception.details).toEqual({
		errors: [expect.stringContaining("/")],
	});
	expect(InvalidPropertyValue.name).toBe("InvalidPropertyValue");
	expect(InvalidPropertyValue.layer).toBe(ExceptionLayers.Property);
});

test("types details by the message parameter", () => {
	const exception = new InvalidPropertyValue({
		source: "x",
		details: { errors: ["bad"] },
	});

	expect(exception.message).toBe('Invalid value for property "x": bad');
	expectTypeOf(exception.details).toEqualTypeOf<{
		readonly errors: readonly string[];
	}>();
	() => {
		// @ts-expect-error details are required
		new InvalidPropertyValue({ source: "x" });
		new PropertyRequired({ source: "x" });
	};
});

test("propagate keeps the trace, from the origin to the top", () => {
	const property = raise(() => new Name(undefined as never));
	const exception = property
		.propagate({ layer: ExceptionLayers.Entity, source: "User" })
		.propagate({ layer: ExceptionLayers.UseCase, source: "CreateUser" });

	expect(exception.name).toBe("PropertyRequired");
	expect(exception.message).toBe(property.message);
	expect(exception.origin).toBe(property);
	expect(exception.trace.map(({ layer, source }) => [layer, source])).toEqual([
		[ExceptionLayers.Property, "name"],
		[ExceptionLayers.Entity, "User"],
		[ExceptionLayers.UseCase, "CreateUser"],
	]);
	expect(exception.is(PropertyRequired)).toBe(true);
	expect(exception.is("PropertyRequired")).toBe(true);
	expect(exception.is(InvalidPropertyValue)).toBe(false);
	expect(exception.passedThrough(ExceptionLayers.Entity)).toBe(true);
	expect(exception.passedThrough(ExceptionLayers.Output)).toBe(false);
});

test("a declared exception with a cause continues its trace", () => {
	const property = raise(() => new Name("a"));
	const exception = new UserNotCreated({
		source: "CreateUser",
		cause: property,
	});

	expect(exception.cause).toBe(property);
	expect(exception.trace.map(({ name }) => name)).toEqual([
		"InvalidPropertyValue",
		"UserNotCreated",
	]);
	expect(exception.find(InvalidPropertyValue)?.details.errors).toHaveLength(1);
	expect(String(exception)).toBe(
		[
			"UserNotCreated [use-case @ CreateUser]: Could not create the user.",
			`  <- InvalidPropertyValue [property @ name]: ${property.message}`,
		].join("\n"),
	);
	expect(JSON.parse(JSON.stringify(exception))).toMatchObject({
		name: "UserNotCreated",
		layer: "use-case",
		source: "CreateUser",
		trace: [{ name: "InvalidPropertyValue" }, { name: "UserNotCreated" }],
	});
});

test("from wraps an error that is not an exception", () => {
	const error = new TypeError("boom");
	const scope = { layer: ExceptionLayers.Repository, source: "UserRepository" };
	const exception = Exception.from(error, scope);

	expect(exception.name).toBe(UNEXPECTED_ERROR);
	expect(exception.message).toBe("boom");
	expect(exception.layer).toBe(ExceptionLayers.Repository);
	expect(exception.cause).toBe(error);
	expect(Exception.from(exception, scope)).toBe(exception);
});

test("guard resolves an exception with a value", () => {
	const name = guard(
		{ layer: ExceptionLayers.UseCase, source: "CreateUser" },
		() => new Name("a").value,
		(exception, pass) => (exception.is(InvalidPropertyValue) ? "abc" : pass()),
	);

	expect(name).toBe("abc");
});

test("guard passes an exception up with its trace", () => {
	const scope = { layer: ExceptionLayers.UseCase, source: "CreateUser" };
	const exception = raise(() =>
		guard(
			scope,
			() => new Name(undefined as never),
			(exception, pass) =>
				exception.is(InvalidPropertyValue) ? new Name("abc") : pass(),
		),
	);

	expect(exception.trace.map(({ layer }) => layer)).toEqual([
		ExceptionLayers.Property,
		ExceptionLayers.UseCase,
	]);

	const passed = raise(() => guard(scope, () => new Name("a")));
	expect(passed.origin).toBeInstanceOf(InvalidPropertyValue);
	expect(passed.layer).toBe(ExceptionLayers.UseCase);
});

test("guard wraps unknown errors in its scope, once", () => {
	const exception = raise(() =>
		guard({ layer: ExceptionLayers.Output, source: "http" }, () => {
			throw new Error("boom");
		}),
	);

	expect(exception.name).toBe(UNEXPECTED_ERROR);
	expect(exception.trace).toHaveLength(1);
	expect(exception.cause).toBeInstanceOf(Error);
});

test("guard handles promises", async () => {
	const scope = { layer: ExceptionLayers.Repository, source: "UserRepository" };
	const fail = async () => new Name("a");

	expect(
		await guard(scope, fail, async () => new Name("abc")).then((n) => n.value),
	).toBe("abc");

	const rejected = (await guard(scope, fail).catch(
		(error) => error,
	)) as Exception;
	expect(rejected.trace.map(({ layer }) => layer)).toEqual([
		ExceptionLayers.Property,
		ExceptionLayers.Repository,
	]);
});

test("blueprint exceptions name the plugin that raised them", () => {
	const Broken = blueprintPluginOf("broken", { optional: Name });
	const exception = raise(() => blueprintOf([Broken], () => ({})));

	expect(exception).toBeInstanceOf(ReservedBlueprintKey);
	expect(exception.layer).toBe(ExceptionLayers.Blueprint);
	expect(exception.source).toBe("broken");
});
