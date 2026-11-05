import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Std } from "../../std/blueprint-plugin";
import { Id } from "../../std/properties/identity";
import { Password } from "../../std/properties/password";
import { DeletedAt } from "../../std/properties/time";
import { propertyOf } from "../property/property";
import { blueprintPluginOf } from "./blueprint-plugin";
import { fieldOf } from "./callable";
import { optionalOf } from "./optional";
import type { BlueprintValue } from "./types/blueprint.interface";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	default: "Demo",
});

test("accepts undefined and still validates a value", () => {
	const OptionalName = optionalOf(Name);

	expect(new OptionalName(undefined).value).toBeUndefined();
	expect(new OptionalName("abc").value).toBe("abc");
	expect(() => new OptionalName("ab")).toThrow(
		'Invalid value for property "name"',
	);
	expect(() => new Name(undefined as never)).toThrow("is required");
	expect(OptionalName.type.optional).toBe(true);
	expect(OptionalName.demo().value).toBe("Demo");
});

test("keeps the methods, statics and handlers of the property", async () => {
	const OptionalPassword = optionalOf(Password);
	const hash = (await OptionalPassword.hash("Str0ng!pass")).value;
	const password = new OptionalPassword(hash);

	expect(password).toBeInstanceOf(Password);
	expect(password.value).toBe(hash);
	expect(await password.verify("Str0ng!pass")).toBe(true);
	expect(await new OptionalPassword(undefined).verify("Str0ng!pass")).toBe(
		false,
	);
	expect(() => new OptionalPassword("Str0ng!pass")).toThrow(
		'Invalid value for property "password"',
	);
	expect(optionalOf(Id).generate().value[14]).toBe("7");
});

test("is cached, and an optional property is returned as it is", () => {
	expect(optionalOf(Name)).toBe(optionalOf(Name));
	expect(optionalOf(DeletedAt)).toBe(DeletedAt);
});

test("ctx.optional mirrors ctx", () => {
	const Extra = blueprintPluginOf("extra", { name: Name });

	blueprintOf([Extra], (ctx) => {
		expect(Object.keys(ctx.optional)).toEqual(
			Object.keys(Std.properties).concat("name"),
		);
		expect(fieldOf(ctx.optional.name)).toBe(optionalOf(Name));
		return {};
	});
});

test("optional properties become optional keys in the schema and the type", () => {
	const User = blueprintOf((ctx) => ({
		email: ctx.email,
		phone: ctx.optional.phone,
		password: ctx.optional.password,
	}));

	expect(User.schema.match({ email: "a@b.co" })).toBe(true);
	expect(User.schema.match({ email: "a@b.co", phone: "+5511999999999" })).toBe(
		true,
	);
	expect(User.schema.match({ email: "a@b.co", phone: "123" })).toBe(false);
	expect(User.schema.match({ phone: "+5511999999999" })).toBe(false);

	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		email: string;
		phone?: string;
		password?: string;
	}>();
	expectTypeOf(new User.properties.password(undefined).value).toEqualTypeOf<
		string | undefined
	>();
	expectTypeOf(new User.properties.password(undefined).verify).toEqualTypeOf<
		(input: string) => Promise<boolean>
	>();
});

test('"optional" cannot be a plugin property', () => {
	const Broken = blueprintPluginOf("broken", { optional: Name });

	expect(() => blueprintOf([Broken], () => ({}))).toThrow(
		'"optional" is reserved',
	);
});
