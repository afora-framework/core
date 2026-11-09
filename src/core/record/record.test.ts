import { describe, expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Slug } from "../../std/properties/identity";
import { Password } from "../../std/properties/password";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { InvalidPropertyValue, PropertyRequired } from "../property/exceptions";
import { propertyOf } from "../property/property";
import { Meta } from "../symbols/meta";
import { RESERVED_RECORD_KEYS } from "./abstract-record";
import {
	InvalidRecordValue,
	ReservedRecordKey,
	UndeclaredRecordProperty,
} from "./exceptions";
import { MASK } from "./mask";
import { recordOf } from "./record";
import type {
	RecordChange,
	RecordEffects,
	RecordValue,
} from "./types/record.interface";

const Address = blueprintOf((ctx) => ({ street: ctx.text, zip: ctx.string }));

const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.text,
	nickname: ctx.optional.string,
	address: Address,
	billing: optionalOf(Address),
	tags: listOf(ctx.string, { maxItems: 2 }),
}));

const user = {
	name: "Jane",
	address: { street: "Main St", zip: "01310-100" },
	tags: ["a"],
};

/** A record of `UserBlueprint` that exposes the protected `set`. */
class User extends recordOf(UserBlueprint) {
	update<Key extends keyof RecordValue<User>>(
		key: Key,
		value: RecordValue<User>[Key],
	): this {
		return this.set(key, value);
	}
}

function raise(run: () => unknown): Exception {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error;
		throw error;
	}
	throw new Error("expected an exception");
}

test("stores the blueprint, and each key of the value as a member", () => {
	const record = new User(user);

	expect(User.blueprint).toBe(UserBlueprint);
	expect(record[Meta].blueprint).toBe(UserBlueprint);
	expect(record.name).toBe("Jane");
	expect(record.address).toEqual(user.address);
	expect(record.nickname).toBeUndefined();
	expect(record).not.toHaveProperty("value");
	expect(JSON.parse(JSON.stringify(record))).toEqual(user);
	() => {
		// @ts-expect-error the keys are read-only
		record.name = "Ann";
		// @ts-expect-error `set` is protected
		record.set("name", "Ann");
	};
});

test("a key cannot take the name of a member of the record", () => {
	for (const key of ["set", "toJSON", "onSet"]) {
		const Broken = blueprintOf((ctx) => ({ [key]: ctx.string }));
		expect(() => recordOf(Broken)).toThrow(ReservedRecordKey);
	}

	const Named = blueprintOf((ctx) => ({
		name: ctx.string,
		change: ctx.string,
	}));
	expect(() => recordOf(Named, { change: ["name"] })).toThrow(
		ReservedRecordKey,
	);
	expect(new (recordOf(Named))({ name: "a", change: "b" }).change).toBe("b");
});

test("a key cannot take the name of a member every object inherits", () => {
	for (const key of Object.getOwnPropertyNames(Object.prototype)) {
		expect(RESERVED_RECORD_KEYS).toContain(key);
		const Broken = blueprintOf((ctx) => ({ [key]: ctx.string }));
		expect(() => recordOf(Broken)).toThrow(ReservedRecordKey);
	}

	const Shadow = blueprintOf((ctx) => ({ toString: ctx.string }));
	expect(() => recordOf(Shadow)).toThrow(
		'"toString" is a member of record "record"',
	);
	expect(Object.isFrozen(RESERVED_RECORD_KEYS)).toBe(true);
});

test("the constructor takes the value inferred from the blueprint", () => {
	type Value = {
		name: string;
		nickname?: string;
		address: { street: string; zip: string };
		billing?: { street: string; zip: string };
		tags: string[];
	};

	expectTypeOf<ConstructorParameters<typeof User>>().toEqualTypeOf<[Value]>();
	expectTypeOf<RecordValue<User>>().toEqualTypeOf<Value>();
	expectTypeOf(new User(user).name).toEqualTypeOf<string>();
	expectTypeOf(new User(user).billing).toEqualTypeOf<
		{ street: string; zip: string } | undefined
	>();
	() => {
		// @ts-expect-error `address` is required
		new User({ name: "Jane", tags: [] });
		// @ts-expect-error `name` is a string
		new User({ ...user, name: 1 });
	};
});

test("each value goes through its field's handlers, at any depth", () => {
	const record = new User({
		...user,
		name: "  Jane ",
		billing: { street: " Side St ", zip: "x" },
	});

	expect(record.name).toBe("Jane");
	expect(record.billing?.street).toBe("Side St");
	expect(Object.isFrozen(record.address)).toBe(true);
	expect(Object.isFrozen(record.tags)).toBe(true);
});

test("drops the keys left undefined", () => {
	const record = new User({ ...user, nickname: undefined });

	expect(Object.keys(record.toJSON())).toEqual(["name", "address", "tags"]);
});

test("a key the blueprint does not declare is rejected, at any depth", () => {
	const top = raise(() => new User({ ...user, extra: 1 } as never));
	expect(top).toBeInstanceOf(UndeclaredRecordProperty);
	expect(top.layer).toBe(ExceptionLayers.Record);
	expect(top.source).toBe("User");
	expect(top.details).toEqual({ key: "extra" });
	expect(top.message).toBe(
		'Property "extra" is not declared in record "User".',
	);

	const extra = { ...user.address, extra: 1 };
	expect(
		raise(() => new User({ ...user, address: extra } as never)).details,
	).toEqual({ key: "address.extra" });
	expect(
		raise(() => new User({ ...user, billing: extra } as never)).details,
	).toEqual({ key: "billing.extra" });
	expect(
		raise(() => new User({ ...user, ...JSON.parse('{"__proto__":{}}') }))
			.details,
	).toEqual({ key: "__proto__" });

	class Book extends recordOf(
		blueprintOf(() => ({
			addresses: listOf(Address),
			grid: listOf(listOf(Address)),
		})),
	) {}
	expect(
		raise(
			() => new Book({ addresses: [user.address, extra], grid: [] } as never),
		).details,
	).toEqual({ key: "addresses.1.extra" });
	expect(
		raise(() => new Book({ addresses: [], grid: [[extra]] } as never)).details,
	).toEqual({ key: "grid.0.0.extra" });

	const record = new User(user);
	expect(raise(() => record.update("address", extra as never)).details).toEqual(
		{ key: "address.extra" },
	);
	expect(record.address).toEqual(user.address);

	() => {
		new User({
			name: "Jane",
			address: user.address,
			tags: [],
			// @ts-expect-error `extra` is not a key of the blueprint
			extra: 1,
		});
		new User({
			name: "Jane",
			address: {
				street: "Main St",
				zip: "1",
				// @ts-expect-error nor of a nested one
				extra: 1,
			},
			tags: [],
		});
	};
});

test("the keys are members of the prototype; toJSON gives the plain value", () => {
	const record = new User(user);

	expect(record.name).toBe("Jane");
	expect(Object.keys(record)).not.toContain("name");
	expect({ ...record }).not.toHaveProperty("name");
	expect(record.toJSON()).toEqual(user);
	expect(Object.isFrozen(record.toJSON())).toBe(true);
});

test("an invalid value names the key of the record", () => {
	const property = raise(() => new User({ ...user, name: "   " }));
	expect(property.is(InvalidPropertyValue)).toBe(true);
	expect(property.layer).toBe(ExceptionLayers.Record);
	expect(property.source).toBe("User");
	expect(property.details).toEqual({ key: "name" });

	const nested = raise(
		() => new User({ ...user, address: { street: "Main St" } as never }),
	);
	expect(nested.is(PropertyRequired)).toBe(true);
	expect(nested.details).toEqual({ key: "address.zip" });

	expect(() => new User({ ...user, tags: ["a", "b", "c"] })).toThrow(
		'Invalid value for "tags" of record "User": must have at most 2 items',
	);
	expect(
		raise(() => new User({ ...user, tags: [1] as never })).details,
	).toEqual({ key: "tags.0" });
	expect(() => new User({ ...user, address: undefined as never })).toThrow(
		InvalidRecordValue,
	);
	expect(() => new User({ ...user, address: "x" as never })).toThrow(
		"must be an object",
	);
});

test("set validates the value and replaces it", () => {
	const record = new User(user);

	expect(record.update("name", " Ann ").update("nickname", "an")).toBe(record);
	expect(record.toJSON()).toEqual({ ...user, name: "Ann", nickname: "an" });

	record.update("nickname", undefined);
	expect(record.toJSON()).not.toHaveProperty("nickname");

	expect(raise(() => record.update("name", "")).is(InvalidPropertyValue)).toBe(
		true,
	);
	expect(record.name).toBe("Ann");
	expect(() => record.update("other" as never, 1 as never)).toThrow(
		UndeclaredRecordProperty,
	);
	() => {
		// @ts-expect-error `name` is a string
		record.update("name", 1);
	};
});

test("onSet runs the effect of the key set, after it is stored", () => {
	const changes: unknown[] = [];

	class Effects extends User {
		protected override onSet(): RecordEffects<Effects> {
			return {
				name: (value, previous) => {
					expectTypeOf(value).toEqualTypeOf<string>();
					changes.push(["name", value, previous, this.name]);
				},
				address: (value) => changes.push(["address", value.street]),
			};
		}
	}

	const record = new Effects(user);
	expect(changes).toEqual([]);

	record.update("name", "Ann");
	record.update("address", { street: "Side St", zip: "1" });
	record.update("tags", []);

	expect(changes).toEqual([
		["name", "Ann", "Jane", "Ann"],
		["address", "Side St"],
	]);
});

test("a record of a joined blueprint takes every field of both", () => {
	const Timestamps = blueprintOf((ctx) => ({ createdAt: ctx.createdAt }));
	const Customer = recordOf(UserBlueprint.join(Timestamps));
	const createdAt = new Date().toISOString();

	expect(new Customer({ ...user, createdAt }).createdAt).toBe(createdAt);
	expect(raise(() => new Customer(user as never)).is(PropertyRequired)).toBe(
		true,
	);
});

const Account = blueprintOf((ctx) => ({
	email: ctx.email,
	token: ctx.string,
	password: ctx.password,
	recovery: ctx.list.optional.password,
	name: ctx.text,
}));
const password = Password.demo().value;
const account = {
	email: "jane@example.com",
	token: "t",
	password,
	name: "Jane",
};

test("options name the sensitive, unique and changeable keys", () => {
	const Record = recordOf(Account, {
		sensitive: ["token"],
		unique: ["email"],
		change: ["password", "name"],
	});

	expect(Record.options).toEqual({
		sensitive: ["token", "password", "recovery"],
		unique: ["email"],
		change: ["password", "name"],
	});
	expect(new Record(account)[Meta].options).toBe(Record.options);
	expect(recordOf(Account).options).toEqual({
		sensitive: ["password", "recovery"],
		unique: [],
		change: [],
	});
	expect(() => recordOf(Account, { unique: ["other" as never] })).toThrow(
		UndeclaredRecordProperty,
	);
	() => {
		// @ts-expect-error `other` is not a key of the blueprint
		recordOf(Account, { sensitive: ["other"] });
	};
});

test("a Slug key, optional or not, is always unique; a list of them is not", () => {
	const Post = blueprintOf((ctx) => ({
		title: ctx.text,
		code: ctx.string,
		slug: ctx.slug,
		alias: ctx.optional.slug,
		previous: ctx.list.slug,
	}));

	expect(recordOf(Post).options.unique).toEqual(["slug", "alias"]);
	expect(recordOf(Post, { unique: ["alias", "code"] }).options.unique).toEqual([
		"code",
		"slug",
		"alias",
	]);
	expect(recordOf(Post, { unique: ["slug"] }).options.unique).toEqual([
		"slug",
		"alias",
	]);
	expect(recordOf(blueprintOf(() => ({ s: Slug }))).options.unique).toEqual([
		"s",
	]);

	const Record = recordOf(Post);
	const record = new Record({
		title: "Hello",
		code: "c",
		slug: "  Olá Mundo! ",
		previous: ["Old Post"],
	});
	expect(record.slug).toBe("ola-mundo");
	expect(record.previous).toEqual(["old-post"]);
});

test("sensitive keys are masked in toJSON, a Password always", () => {
	const Record = recordOf(Account, { sensitive: ["token"] });
	const record = new Record({ ...account, recovery: [password] });
	const hidden = MASK;

	expect(record.password).toBe(password);
	expect(record.recovery).toEqual([password]);
	expect(JSON.parse(JSON.stringify(record))).toEqual({
		email: account.email,
		token: MASK,
		password: hidden,
		recovery: [hidden],
		name: "Jane",
	});
});

test("a Password is masked at any depth, and still read in clear", () => {
	const Credentials = blueprintOf((ctx) => ({
		label: ctx.string,
		password: ctx.password,
		backup: ctx.optional.password,
	}));
	const Deep = blueprintOf(() => ({ inner: listOf(Credentials) }));
	const Holder = recordOf(
		blueprintOf((ctx) => ({
			email: ctx.email,
			credentials: Credentials,
			spare: optionalOf(Credentials),
			many: listOf(Credentials),
			deep: Deep,
		})),
	);
	const credentials = { label: "main", password };
	const record = new Holder({
		email: "jane@example.com",
		credentials,
		spare: credentials,
		many: [credentials, { ...credentials, backup: password }],
		deep: { inner: [credentials] },
	});
	const hidden = MASK;
	const masked = { label: "main", password: hidden };

	expect(JSON.stringify(record)).not.toContain(password);
	expect(JSON.parse(JSON.stringify(record))).toEqual({
		email: "jane@example.com",
		credentials: masked,
		spare: masked,
		many: [masked, { ...masked, backup: hidden }],
		deep: { inner: [masked] },
	});
	expect(record.credentials.password).toBe(password);
	expect(record.many[1]?.backup).toBe(password);
	expect(Holder.options.sensitive).toEqual([]);
});

test("a sensitive key masks every value beneath it, numbers and booleans too", () => {
	const Profile = recordOf(UserBlueprint, { sensitive: ["address", "tags"] });
	const record = new Profile(user);

	expect(record.toJSON()).toEqual({
		name: "Jane",
		address: { street: MASK, zip: MASK },
		tags: [MASK],
	});
	expect(record.address).toEqual(user.address);

	const Pin = recordOf(
		blueprintOf((ctx) => ({ pin: ctx.integer, admin: ctx.boolean })),
		{ sensitive: ["pin", "admin"] },
	);
	expect(
		JSON.parse(JSON.stringify(new Pin({ pin: 1234, admin: true }))),
	).toEqual({
		pin: MASK,
		admin: MASK,
	});
});

test("change creates a typed change.<key> method that sets the key", () => {
	const changes: unknown[] = [];

	class AccountRecord extends recordOf(Account, {
		change: ["password", "name"],
	}) {
		protected override onSet(): RecordEffects<AccountRecord> {
			return { password: (value) => changes.push(value) };
		}
	}

	const record = new AccountRecord(account);
	const other = Password.demo().value.replace("/C89", "/D89");

	record.change.password(other);
	record.change.name(" Ann ");

	expect(record.password).toBe(other);
	expect(record.name).toBe("Ann");
	expect(changes).toEqual([other]);
	expect(raise(() => record.change.name("")).is(InvalidPropertyValue)).toBe(
		true,
	);
	expect(record.change.name("Jane")).toBe(record);
	expectTypeOf(record.change.name("Jane")).toEqualTypeOf<AccountRecord>();
	expect(recordOf(Account).prototype).not.toHaveProperty("change");
	const { change } = record;
	expect(change.name("Bo")).toBe(record);
	expect(record.name).toBe("Bo");
	expect(record.change).toBe(record.change);
	() => {
		// @ts-expect-error `email` is not in `change`
		record.change.email("a@b.co");
		// @ts-expect-error `name` is a string
		record.change.name(1);
	};
});

test("onSetAll runs on any change, before the effect of its key", () => {
	const calls: unknown[] = [];

	class Effects extends User {
		protected override onSetAll(change: RecordChange<Effects>) {
			calls.push(["all", change.key, change.value, change.previous]);
			if (change.key === "name") {
				expectTypeOf(change.value).toEqualTypeOf<string>();
			}
		}

		protected override onSet(): RecordEffects<Effects> {
			return { name: (value) => calls.push(["name", value]) };
		}
	}

	const record = new Effects(user);
	expect(calls).toEqual([]);

	record
		.update("name", " Ann ")
		.update("tags", [])
		.update("nickname", undefined);

	expect(calls).toEqual([
		["all", "name", "Ann", "Jane"],
		["name", "Ann"],
		["all", "tags", [], ["a"]],
		["all", "nickname", undefined, undefined],
	]);
});

test("the value of a record must be an object", () => {
	for (const value of [null, undefined, "x", ["a"]]) {
		const exception = raise(() => new User(value as never));
		expect(exception).toBeInstanceOf(InvalidRecordValue);
		expect(exception.message).toBe(
			'Invalid value for record "User": must be an object',
		);
	}
});

test("any property declared sensitive or unique is treated as Password and Slug are", () => {
	const ApiKey = propertyOf({
		name: "apiKey",
		schema: Type.String(),
		sensitive: true,
	});
	const Handle = propertyOf({
		name: "handle",
		schema: Type.String(),
		unique: true,
	});
	const Integration = recordOf(
		blueprintOf(() => ({
			key: ApiKey,
			backup: optionalOf(ApiKey),
			keys: listOf(ApiKey),
			handle: Handle,
			handles: listOf(Handle),
		})),
	);
	const record = new Integration({
		key: "k-123",
		backup: "k-456",
		keys: ["k-789"],
		handle: "jane",
		handles: ["ann"],
	});

	expect(Integration.options.sensitive).toEqual(["key", "backup", "keys"]);
	expect(Integration.options.unique).toEqual(["handle"]);
	expect(record.toJSON()).toEqual({
		key: MASK,
		backup: MASK,
		keys: [MASK],
		handle: "jane",
		handles: ["ann"],
	});
	expect(record.key).toBe("k-123");
});

test("the mask has the same length whatever the value", () => {
	const Record = recordOf(Account, { sensitive: ["token"] });
	const short = new Record({ ...account, token: "t" }).toJSON();
	const long = new Record({ ...account, token: "t".repeat(64) }).toJSON();

	expect(short.token).toBe(MASK);
	expect(long.token).toBe(MASK);
	expect(short.password).toBe(long.password);
});

test("a class extending a record cannot declare a member named after a key", () => {
	class Named extends recordOf(UserBlueprint) {
		// @ts-expect-error a key cannot be redeclared, which `new` checks too
		name(): string {
			return "hidden";
		}
	}
	class Deeper extends User {
		// @ts-expect-error see above
		get tags(): string[] {
			return [];
		}
	}

	expect(() => new Named(user)).toThrow('"name" is a member of record "Named"');
	expect(raise(() => new Deeper(user)).is(ReservedRecordKey)).toBe(true);
	expect(new User(user).name).toBe("Jane");
});

describe("record lists", () => {
	test("a list with fewer items than minItems is rejected, naming the key", () => {
		const Post = recordOf(
			blueprintOf((ctx) => ({
				tags: listOf(ctx.string, { minItems: 1, maxItems: 2 }),
			})),
		);
		const exception = raise(() => new Post({ tags: [] }));

		expect(exception.is(InvalidRecordValue)).toBe(true);
		expect(exception.details).toEqual({
			key: "tags",
			errors: ["must have at least 1 items"],
		});
		expect(new Post({ tags: ["a"] }).tags).toEqual(["a"]);
	});
});
