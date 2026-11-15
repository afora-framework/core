# OpenAPI

`toOpenAPI` turns any field (a property, blueprint, list, variant, record or entity) into an OpenAPI 3.1 schema, which is plain JSON Schema. A variant field (`variantOf`) is `oneOf` with one object per variant, each with the key as a `const`, and a `discriminator` naming the key. Given named models, it gives the `components` of a document, and a record named among them is a `$ref` wherever another model holds it:

```ts
import { blueprintOf, entityOf, toOpenAPI } from "@afora/core";

const User = entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text({ max: 80, description: "Full name" }),
		email: ctx.email({ examples: ["jane@example.com"] }),
		password: ctx.password,
	})),
);
const Post = entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, author: User })),
);

toOpenAPI(User); // { type: "object", properties: { id: {..., readOnly: true }, ... } }

const document = {
	openapi: "3.1.0",
	info: { title: "Blog", version: "1.0.0" },
	paths: {},
	components: toOpenAPI({ User, Post }), // Post.author is { $ref: "#/components/schemas/User" }
};
```

What `Property.with` (or `ctx.<property>(options)`) gives, `description`, `examples`, bounds and the rest, is kept. Sensitive keys (`Password`, `options.sensitive`) are `writeOnly`, the identity of an entity (`id`, `createdAt`, `updatedAt`, `deletedAt`) is `readOnly`, optional keys are left out of `required`, and every object has `additionalProperties: false`, since blueprints reject undeclared keys. Records not named among the models are inline; `refPrefix` changes where a `$ref` points (`"#/components/schemas/"` by default). A model that is not a field throws `InvalidOpenAPIModel`.

## JSON Schema

`jsonSchemaOf(field)` gives the same schema as a standalone JSON Schema (draft 2020-12) document, for whatever reads JSON Schema rather than OpenAPI: a JSON Schema validator, a form, or an AI client that asks what to send, as an MCP tool such as `describe_schema` returns it. It takes the same fields as `toOpenAPI` (a property, blueprint, list, variant, record or entity) and keeps the same keywords, with these differences: the document has `$schema: "https://json-schema.org/draft/2020-12/schema"`, each record held inside is defined once under `$defs`, by its name ([`recordNameOf`](records.md)), and referenced as `{ $ref: "#/$defs/Address" }` (a second record of the same name is `Address2`), a variant is `oneOf` without the `discriminator`, which is an OpenAPI keyword, the identity of an entity is `readOnly` and not `required`, since what the server sets is not asked of the writer (as `safeParse` does not ask it), and the schema of a property with an `$id` (a TypeBox schema given one) is defined once under `$defs`, without its `$id`, and referenced from there, so the document needs nothing outside it. A record or entity given is the document itself, not a `$ref`.

```ts
import { blueprintOf, jsonSchemaOf, recordOf } from "@afora/core";

const Address = recordOf(
	blueprintOf((ctx) => ({ street: ctx.text, zip: ctx.string })),
	{ name: "Address" },
);
const Contact = blueprintOf((ctx) => ({
	name: ctx.text,
	home: Address,
	tags: ctx.list.string,
}));

jsonSchemaOf(Contact);
// {
// 	$schema: "https://json-schema.org/draft/2020-12/schema",
// 	type: "object",
// 	properties: { name: {...}, home: { $ref: "#/$defs/Address" }, tags: { type: "array", ... } },
// 	required: ["name", "home", "tags"],
// 	additionalProperties: false,
// 	$defs: { Address: { type: "object", ... } },
// }
```

The schema of a sensitive key is that of the value stored, marked `writeOnly`: a `Password` is its hash. The document is typed `JSONSchema`. A value that is not a field throws `InvalidOpenAPIModel`.

## Documents

To document commands rather than models, the [`openapi` sink](outputs.md) of an output builds the whole document, paths included, reusing `toOpenAPI` for the schemas: path parameters, success statuses, response headers and security schemes come from its routing options.
