# OpenAPI

`toOpenAPI` turns any field (a property, blueprint, list, record or entity) into an OpenAPI 3.1 schema, which is plain JSON Schema. Given named models, it gives the `components` of a document, and a record named among them is a `$ref` wherever another model holds it:

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

To document commands rather than models, the [`openapi` sink](outputs.md) of an output builds the whole document, paths included, reusing `toOpenAPI` for the schemas: path parameters, success statuses, response headers and security schemes come from its routing options.
