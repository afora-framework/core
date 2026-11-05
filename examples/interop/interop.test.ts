import { expect, expectTypeOf, test } from "bun:test";
import { sValidator } from "@hono/standard-validator";
import { getDotPath } from "@standard-schema/utils";
import { FieldApi, FormApi } from "@tanstack/form-core";
import { initTRPC, TRPCError } from "@trpc/server";
import { Hono } from "hono";
import { Email, type StandardSchemaV1 } from "../../src/index.ts";
import { invalidBody, User, UserBlueprint, validBody } from "./schemas.ts";

const json = (body: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

test("hono: a valid body reaches the handler handled", async () => {
	const app = new Hono().post(
		"/users",
		sValidator("json", UserBlueprint),
		(c) => c.json(c.req.valid("json")),
	);

	const response = await app.request("/users", json(validBody));

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		name: "Jane",
		email: "jane@example.com",
		slug: "ola-mundo",
		addresses: [{ street: "Main St", zip: "1" }],
	});
});

test("hono: the handler sees the output type of the blueprint", () => {
	new Hono().post("/users", sValidator("json", UserBlueprint), (c) => {
		const body = c.req.valid("json");
		expectTypeOf(body.slug).toEqualTypeOf<string>();
		return c.json(body.addresses.length);
	});
});

test("hono: an invalid body is a 400 with afora's issues and paths", async () => {
	const app = new Hono().post(
		"/users",
		sValidator("json", UserBlueprint),
		(c) => c.json(c.req.valid("json")),
	);

	const response = await app.request("/users", json(invalidBody));
	const body = (await response.json()) as {
		success: boolean;
		error: { message: string; path: (string | number)[] }[];
	};

	expect(response.status).toBe(400);
	expect(body.success).toBe(false);
	expect(body.error.map((issue) => issue.path)).toEqual([
		["email"],
		["addresses", 0, "zip"],
	]);
});

test("trpc: a record class as input gives the resolver an instance", async () => {
	const t = initTRPC.create();
	const router = t.router({
		create: t.procedure.input(User).mutation(({ input }) => {
			expectTypeOf(input).not.toBeAny();
			return {
				isUser: input instanceof User,
				name: input.name,
				initials: (input as User).initials,
				email: input.email,
				slug: input.slug,
			};
		}),
	});

	const result = await t
		.createCallerFactory(router)({})
		.create(validBody as never);

	expect(result).toEqual({
		isUser: true,
		name: "Jane",
		initials: "J",
		email: "jane@example.com",
		slug: "ola-mundo",
	});
});

test("trpc: invalid input is BAD_REQUEST, its cause holding the issues", async () => {
	const t = initTRPC.create();
	const router = t.router({
		create: t.procedure.input(User).mutation(({ input }) => input.name),
	});

	const error = await t
		.createCallerFactory(router)({})
		.create(invalidBody as never)
		.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

	expect(error).toBeInstanceOf(TRPCError);
	const { code, cause } = error as TRPCError;
	expect(code).toBe("BAD_REQUEST");
	const issues = (cause as unknown as { issues: StandardSchemaV1.Issue[] })
		.issues;
	expect(issues.map((issue) => issue.path)).toEqual([
		["email"],
		["addresses", 0, "zip"],
	]);
});

test("trpc: a blueprint as input gives the plain handled object", async () => {
	const t = initTRPC.create();
	const router = t.router({
		create: t.procedure.input(UserBlueprint).mutation(({ input }) => input),
	});

	const result = await t.createCallerFactory(router)({}).create(validBody);

	expect(result.slug).toBe("ola-mundo");
	expect(result).not.toBeInstanceOf(User);
});

test("tanstack form: a property class validates a field", async () => {
	const form = new FormApi({ defaultValues: { email: "" } });
	form.mount();
	const field = new FieldApi({
		form,
		name: "email",
		validators: { onChange: Email },
	});
	field.mount();

	field.setValue("nope");
	expect(field.state.meta.errors).toHaveLength(1);
	expect(field.state.meta.errors[0]).toMatchObject({ code: "invalid_value" });
	expect(field.state.meta.isValid).toBe(false);

	field.setValue("jane@example.com");
	expect(field.state.meta.errors).toHaveLength(0);
	expect(field.state.meta.isValid).toBe(true);
});

test("tanstack form: a blueprint validates the form, errors by field", () => {
	const form = new FormApi({
		defaultValues: {
			name: "Jane",
			email: "",
			slug: "a b",
			addresses: [],
		} as StandardSchemaV1.InferInput<typeof UserBlueprint>,
		validators: { onChange: UserBlueprint },
	});
	form.mount();
	const email = new FieldApi({ form, name: "email" });
	email.mount();

	email.setValue("not-an-email");

	expect(form.state.isValid).toBe(false);
	const [issue] = email.state.meta.errors as StandardSchemaV1.Issue[];
	expect(issue?.path).toEqual(["email"]);

	email.setValue("jane@example.com");
	expect(form.state.isValid).toBe(true);
});

test("standard-schema utils read a afora issue path", () => {
	const result = UserBlueprint["~standard"].validate(invalidBody);
	if (result instanceof Promise || !result.issues) throw new Error("issues");

	expect(result.issues.map(getDotPath)).toEqual(["email", "addresses.0.zip"]);
});
