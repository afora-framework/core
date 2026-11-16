// Runs the built package on plain Node: `bun run smoke`.
import assert from "node:assert/strict";
// The application supplies the TypeBox peer used by these schemas and core.
import { Type } from "typebox";
import {
	compileRoutes,
	outputValueOf,
	RESERVED_RECORD_KEYS,
} from "../dist/adapters.js";
import { jwtOf, sliceOf, sliceValue } from "../dist/experimental.js";
import {
	blueprintOf,
	commandOf,
	DeletedEntity,
	entityOf,
	Id,
	MASK,
	outputOf,
	Password,
	PasswordHasherRequired,
	propertyOf,
	Route,
	recordOf,
	useCaseOf,
} from "../dist/index.js";
import { providerContract } from "../dist/testing/index.js";

// property
const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	default: "Demo",
});
assert.equal(new Name("Ana").value, "Ana");
assert.throws(() => new Name("a"));

// blueprint
const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const UserBlueprint = blueprintOf((ctx) => ({
	id: ctx.id,
	email: ctx.email,
	address: Address,
	password: ctx.password,
}));
assert.deepEqual(Object.keys(UserBlueprint.properties).sort(), [
	"address",
	"email",
	"id",
	"password",
]);

// id
const first = Id.generate().value;
const second = Id.generate().value;
assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
assert.ok(first < second);

// password: native argon2 needs Node >= 24.7
let hash = Password.demo().value;
try {
	const password = await Password.hash("Str0ng!pass");
	hash = password.value;
	assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=2,p=1\$/);
	assert.equal(await password.verify("Str0ng!pass"), true);
	assert.equal(await password.verify("wrong"), false);
	assert.equal(password.verifySync("Str0ng!pass"), true);
	console.log("password: native argon2 used");
} catch (error) {
	assert.ok(error instanceof PasswordHasherRequired);
	console.log("password: native argon2 missing, explicit exception thrown");
}

// record with a nested blueprint and masking
class User extends recordOf(UserBlueprint) {}
const user = new User({
	id: first,
	email: "ana@example.com",
	address: { street: "Main St", zip: "01310-100" },
	password: hash,
});
assert.equal(user.address.street, "Main St");
const json = JSON.parse(JSON.stringify(user));
assert.equal(json.password, MASK);
assert.equal(json.email, "ana@example.com");

// entity with identity, as a field of another entity
class Author extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ change: ["name"] },
) {}
class Post extends entityOf(blueprintOf(() => ({ author: Author }))) {}
const post = new Post({ author: { name: "Ana" } });
assert.match(post.author.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
assert.equal(post.author.updatedAt, undefined);
post.author.change.name("Bia");
assert.equal(typeof post.author.updatedAt, "string");
post.author.destroy();
assert.throws(() => post.author.change.name("Cy"), DeletedEntity);

// experimental entry shares module state with the main one
const Card = sliceOf(UserBlueprint, { email: true, address: { zip: true } });
assert.deepEqual(Object.keys(Card.properties).sort(), ["address", "email"]);
assert.deepEqual(sliceValue(user, { email: true, password: true }), {
	email: "ana@example.com",
	password: MASK,
});
class Slim extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {}
class Wrapper extends recordOf(blueprintOf(() => ({ slim: Slim }))) {}
const wrapped = new Wrapper({ slim: { title: "x" } });
assert.deepEqual(sliceValue(wrapped, { slim: { title: true } }), {
	slim: { title: "x" },
});
const Only = sliceOf(Wrapper.blueprint, { slim: true });
assert.ok(Only.properties.slim === Slim);

// adapters entry shares module state with the main one (records mask through it)
assert.equal(outputValueOf({ user }).user.password, MASK);
assert.ok(RESERVED_RECORD_KEYS.includes("toJSON"));

// testing entry shares module state with the main one (same exception classes)
assert.equal(typeof providerContract, "function");

// @Route called as a function: Node has no decorator syntax, compiled code calls it like this
const Routed = useCaseOf({
	name: "Routed",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug })),
	response: blueprintOf((ctx) => ({ slug: ctx.slug })),
});
class RoutedGet extends Routed {
	async execute() {
		return this.input;
	}
}
Route("GET", "/posts/{slug}")(RoutedGet, { kind: "class" });
assert.deepEqual(RoutedGet.route, { method: "get", path: "/posts/{slug}" });
assert.equal(Routed.route, undefined);

// JSON Web Tokens run on the Web Crypto of Node, with no Buffer and no node:crypto
const jwt = jwtOf({ secret: "a-secret-of-at-least-thirty-two-characters" });
const signed = await jwt.sign({ subject: "u1", scopes: ["posts:write"] });
assert.deepEqual(await jwt.verify(signed), {
	subject: "u1",
	scopes: ["posts:write"],
});
await assert.rejects(jwt.verify(`${signed}x`));

// Uploads: a file property and a multipart body, read with the FormData of Node
class Upload extends useCaseOf({
	name: "Upload",
	blueprint: blueprintOf((ctx) => ({
		file: ctx.fileOf({ types: ["image/*"], maxBytes: 16 }),
		count: ctx.integer,
	})),
	response: blueprintOf((ctx) => ({ name: ctx.string, count: ctx.integer })),
}) {
	async execute() {
		return { name: this.input.file.name, count: this.input.count };
	}
}
const Media = outputOf({
	name: "Media",
	commands: [commandOf({ name: "Media", useCases: { upload: Upload } })],
});
const [uploadRoute] = compileRoutes(
	Media.operations,
	{},
	{ output: { name: "Media", statuses: Media.statuses } },
	{ source: "smoke" },
).routes;
const multipart = (file) => {
	const form = new FormData();
	form.append("file", file);
	form.append("count", "2");
	const request = new Request("http://smoke.test/", {
		method: "POST",
		body: form,
	});
	return {
		param: () => undefined,
		query: () => ({}),
		header: (name) => request.headers.get(name) ?? undefined,
		text: () => request.text(),
		form: () => request.formData(),
	};
};
const uploaded = await uploadRoute.handle(
	multipart(
		new File(
			[new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
			"a.png",
			{ type: "image/png" },
		),
	),
);
assert.equal(uploaded.status, 200);
assert.deepEqual(JSON.parse(uploaded.body), { name: "a.png", count: 2 });
const refused = await uploadRoute.handle(
	multipart(new File(["text"], "a.txt", { type: "text/plain" })),
);
assert.equal(refused.status, 400);
assert.deepEqual(JSON.parse(refused.body).issues[0].path, ["file"]);
const disguised = await uploadRoute.handle(
	multipart(new File(["<svg/>"], "a.png", { type: "image/png" })),
);
assert.equal(JSON.parse(disguised.body).title, "InvalidFileContent");

console.log(`smoke ok on node ${process.version}`);
