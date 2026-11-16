import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { statusOf } from "../../adapters";
import {
	blueprintOf,
	type CommandInput,
	commandOf,
	entityOf,
	inMemoryProvider,
	repositoryOf,
	resourceOf,
	StdUseCases,
} from "../../index";
import { configure, currentHasher, resetRuntime } from "../runtime";

const ana = "0190a6a0-0000-7000-8000-00000000000a";
const bob = "0190a6a0-0000-7000-8000-00000000000b";
const strong = "Victim@123";

interface Thrown {
	readonly name: string;
	readonly message: string;
	readonly trace?: readonly {
		readonly details?: { readonly issues?: readonly { code: string }[] };
	}[];
}

const failure = (promise: Promise<unknown>): Promise<Thrown> =>
	promise.then(
		() => {
			throw new Error("Expected a failure.");
		},
		(error) => error as Thrown,
	);

const unavailable = (make: () => unknown): string => {
	try {
		make();
	} catch (error) {
		const thrown = error as Thrown;
		if (thrown.name === "UseCaseUnavailable") return thrown.message;
		throw error;
	}
	throw new Error("Expected UseCaseUnavailable.");
};

const loose = StdUseCases.context as unknown as Record<
	string,
	(repository: unknown, options?: unknown) => unknown
>;
const make = (name: string, repository: unknown, options?: unknown) =>
	unavailable(() => loose[name]?.(repository, options));

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ change: ["name"], plugins: (ctx) => [ctx.authenticatable] },
) {}

class Account extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ plugins: (ctx) => [ctx.authenticatable] },
) {}

function accounts() {
	const Users = repositoryOf({
		entity: User,
		provider: inMemoryProvider(),
		actions: [
			"findById",
			"findByEmail",
			"findPage",
			"create",
			"update",
			"delete",
		],
	});
	const self = { key: "id", context: "userId" } as const;
	const Accounts = commandOf({
		name: "Accounts",
		useCases: (ctx) => ({
			register: ctx.register(Users, { as: "user" }),
			login: ctx.login(Users, { as: "user" }),
			...resourceOf(Users, { path: "/users" })(ctx),
			changePassword: ctx.changePassword(Users, { as: "user", owner: self }),
			me: ctx.get(Users, { name: "GetMe", as: "user", owner: self }),
			rename: ctx.update(Users, { name: "Rename", as: "user", owner: self }),
			leave: ctx.delete(Users, { name: "Leave", as: "user", owner: self }),
		}),
	});
	return { Users, Accounts };
}

describe("SEC-01: a password is changed only by changePassword", () => {
	test("SEC-01: update and resourceOf do not take the password", async () => {
		const { Accounts } = accounts();
		const { user: victim } = await Accounts.run("register", {
			name: "Victim",
			email: "v@x.io",
			password: strong,
		});
		const takeover = await failure(
			// @ts-expect-error: password is not an input of update
			Accounts.run("update", { id: victim.id, password: "Pwned@123" }),
		);
		expect(takeover.name).toBe("InvalidUseCaseInput");
		expect(statusOf(takeover)).toBe(400);
		const login = await failure(
			Accounts.run("login", { email: "v@x.io", password: "Pwned@123" }),
		);
		expect(login.name).toBe("UseCaseInvalidCredentials");
		expect(
			(await Accounts.run("login", { email: "v@x.io", password: strong })).user
				.id,
		).toBe(victim.id);
		expectTypeOf<CommandInput<typeof Accounts, "update">>().toEqualTypeOf<{
			readonly id: string;
			readonly name?: string | undefined;
		}>();
	});

	test("SEC-01: an update with only sensitive change keys is refused, pointing to changePassword", () => {
		const Accounts = repositoryOf({
			entity: Account,
			actions: ["findById", "update"],
		});
		expect(make("update", Accounts)).toContain("changePassword");
	});

	test("SEC-01: changePassword checks the current password", async () => {
		const { Accounts } = accounts();
		const { user } = await Accounts.run("register", {
			name: "Ana",
			email: "ana@x.io",
			password: strong,
		});
		const context = { userId: user.id };
		const wrong = await failure(
			Accounts.run(
				"changePassword",
				{ id: user.id, currentPassword: "Wrong@123", password: "Other@456" },
				{ context },
			),
		);
		expect(wrong.name).toBe("UseCaseInvalidCredentials");
		expect(statusOf(wrong)).toBe(401);

		const weak = await failure(
			Accounts.run(
				"changePassword",
				{ id: user.id, currentPassword: strong, password: "weak" },
				{ context },
			),
		);
		expect(weak.name).toBe("InvalidUseCaseInput");

		const changed = await Accounts.run(
			"changePassword",
			{ id: user.id, currentPassword: strong, password: "Other@456" },
			{ context },
		);
		expect(changed.user.toJSON().password).toBe("********");
		expect(await changed.user.verifyPassword("Other@456")).toBe(true);
		await Accounts.run("login", { email: "ana@x.io", password: "Other@456" });
		expect(
			(
				await failure(
					Accounts.run("login", { email: "ana@x.io", password: strong }),
				)
			).name,
		).toBe("UseCaseInvalidCredentials");
		expectTypeOf<
			CommandInput<typeof Accounts, "changePassword">
		>().toEqualTypeOf<{
			readonly id: string;
			readonly currentPassword: string;
			readonly password: string;
		}>();
	});

	test("SEC-01: owner with the key id compares the id of the entity with the caller", async () => {
		const { Accounts } = accounts();
		const { user: victim } = await Accounts.run("register", {
			name: "Victim",
			email: "victim@x.io",
			password: strong,
		});
		const { user: other } = await Accounts.run("register", {
			name: "Other",
			email: "other@x.io",
			password: strong,
		});
		const asOther = { context: { userId: other.id } };
		for (const [name, input] of [
			[
				"changePassword",
				{ id: victim.id, currentPassword: strong, password: "Other@456" },
			],
			["me", { id: victim.id }],
			["rename", { id: victim.id, name: "x" }],
			["leave", { id: victim.id }],
		] as const) {
			const error = await failure(
				(Accounts.run as (...args: unknown[]) => Promise<unknown>)(
					name,
					input,
					asOther,
				),
			);
			expect(error.name).toBe("UseCaseEntityNotFound");
		}
		const asVictim = { context: { userId: victim.id } };
		expect(
			(await Accounts.run("me", { id: victim.id }, asVictim)).user.id,
		).toBe(victim.id);
		expect(
			(await Accounts.run("rename", { id: victim.id, name: "V" }, asVictim))
				.user.name,
		).toBe("V");
	});

	test("SEC-01: create cannot take its id from the owner", () => {
		const { Users } = accounts();
		expect(
			make("create", Users, { owner: { key: "id", context: "userId" } }),
		).toContain('"id"');
	});
});

class Folder extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ plugins: (ctx) => [ctx.ownable] },
) {}
class Category extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
class Note extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.string, folder: Folder })),
	{ plugins: (ctx) => [ctx.ownable] },
) {}
class Card extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.string, category: Category })),
	{ plugins: (ctx) => [ctx.ownable] },
) {}

describe("SEC-03: create loads only the caller's related entities", () => {
	const provider = inMemoryProvider();
	const Folders = repositoryOf({
		entity: Folder,
		provider,
		actions: ["findById", "create"],
	});
	const Categories = repositoryOf({
		entity: Category,
		provider,
		actions: ["findById", "create"],
	});
	const Notes = repositoryOf({
		entity: Note,
		provider,
		relations: [Folders],
		actions: ["findById", "create"],
	});
	const Cards = repositoryOf({
		entity: Card,
		provider,
		relations: [Categories],
		actions: ["findById", "create"],
	});
	const mine = { context: "userId" } as const;
	const C = commandOf({
		name: "C",
		useCases: (ctx) => ({
			mkdir: ctx.create(Folders, { owner: mine }),
			write: ctx.create(Notes, { owner: mine }),
			writeShared: ctx.create(Notes, {
				name: "WriteShared",
				owner: mine,
				relations: { folder: { shared: true } },
			}),
			card: ctx.create(Cards, { owner: mine }),
		}),
	});

	test("SEC-03: another owner's entity is not found", async () => {
		const { item: folder } = await C.run(
			"mkdir",
			{ name: "ana: salary negotiations" },
			{ context: { userId: ana } },
		);
		const error = await failure(
			C.run(
				"write",
				{ text: "x", folderId: folder.id },
				{ context: { userId: bob } },
			),
		);
		expect(error.name).toBe("UseCaseEntityNotFound");
		expect(statusOf(error)).toBe(404);
		const { item } = await C.run(
			"write",
			{ text: "x", folderId: folder.id },
			{ context: { userId: ana } },
		);
		expect(item.folder.id).toBe(folder.id);
	});

	test("SEC-03: relations.<key>.shared lets any owner's entity in", async () => {
		const { item: folder } = await C.run(
			"mkdir",
			{ name: "shared" },
			{ context: { userId: ana } },
		);
		const { item } = await C.run(
			"writeShared",
			{ text: "x", folderId: folder.id },
			{ context: { userId: bob } },
		);
		expect(item.folder.id).toBe(folder.id);
	});

	test("SEC-03: a related entity without the owner key is not checked", async () => {
		const category = await Categories.create(new Category({ name: "general" }));
		const { item } = await C.run(
			"card",
			{ text: "x", categoryId: category.id },
			{ context: { userId: bob } },
		);
		expect(item.category.id).toBe(category.id);
	});

	test("SEC-03: relations names keys the input loads", () => {
		expect(
			make("create", Notes, {
				owner: mine,
				relations: { text: { shared: true } },
			}),
		).toContain("relations.text");
		expect(
			make("create", Notes, {
				owner: mine,
				relations: { folder: { shared: "yes" } },
			}),
		).toContain("relations.folder");
	});

	test("SEC-03: an owner key that holds an entity is compared by its id", async () => {
		class Writer extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
		) {}
		class Shelf extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string, author: Writer })),
		) {}
		class Book extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.string,
				shelf: Shelf,
				author: Writer,
			})),
		) {}
		const provider = inMemoryProvider();
		const Writers = repositoryOf({
			entity: Writer,
			provider,
			actions: ["findById", "create"],
		});
		const Shelves = repositoryOf({
			entity: Shelf,
			provider,
			relations: [Writers],
			actions: ["findById", "create"],
		});
		const Books = repositoryOf({
			entity: Book,
			provider,
			relations: [Writers, Shelves],
			actions: ["findById", "create"],
		});
		const author = { key: "author", context: "userId" } as const;
		const Library = commandOf({
			name: "Library",
			useCases: (ctx) => ({
				shelve: ctx.create(Shelves, { owner: author }),
				write: ctx.create(Books, { owner: author }),
			}),
		});
		const anaW = await Writers.create(new Writer({ name: "Ana" }));
		const bobW = await Writers.create(new Writer({ name: "Bob" }));
		const { item: shelf } = await Library.run(
			"shelve",
			{ name: "Ana's" },
			{ context: { userId: anaW.id } },
		);
		const error = await failure(
			Library.run(
				"write",
				{ title: "x", shelfId: shelf.id },
				{ context: { userId: bobW.id } },
			),
		);
		expect(error.name).toBe("UseCaseEntityNotFound");
		const { item } = await Library.run(
			"write",
			{ title: "x", shelfId: shelf.id },
			{ context: { userId: anaW.id } },
		);
		expect(item.shelf.id).toBe(shelf.id);
	});
});

class Memo extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.string })),
	{ change: ["text"], plugins: (ctx) => [ctx.ownable] },
) {}
class Reassignable extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.string, ownerId: ctx.id })),
	{ change: ["text", "ownerId"] },
) {}

describe("SEC-08: restore with owner", () => {
	const Memos = repositoryOf({
		entity: Memo,
		provider: inMemoryProvider(),
		deletion: "soft",
		actions: ["findById", "exists", "create", "update", "delete", "restore"],
	});
	const mine = { context: "userId" } as const;
	const C = commandOf({
		name: "C",
		useCases: (ctx) => ({
			write: ctx.create(Memos, { owner: mine }),
			erase: ctx.delete(Memos, { owner: mine }),
			restore: ctx.restore(Memos, { owner: mine }),
		}),
	});

	test("SEC-08: another owner's deleted entity is not found, and stays deleted", async () => {
		const asAna = { context: { userId: ana } };
		const { item } = await C.run("write", { text: "ana secret" }, asAna);
		await C.run("erase", { id: item.id }, asAna);
		const error = await failure(
			C.run("restore", { id: item.id }, { context: { userId: bob } }),
		);
		expect(error.name).toBe("UseCaseEntityNotFound");
		expect(await Memos.findById(item.id)).toBeUndefined();
		const restored = await C.run("restore", { id: item.id }, asAna);
		expect(restored.item.isDeleted).toBe(false);
	});

	test("SEC-08: restore with owner needs the exists action", () => {
		const Bare = repositoryOf({
			entity: Memo,
			deletion: "soft",
			actions: ["findById", "restore"],
		});
		expect(make("restore", Bare, { owner: mine })).toContain('"exists"');
	});
});

describe("SEC-09: the owner key is not a change key of update", () => {
	test("SEC-09: update with owner refuses an owner key the input could change", () => {
		const Items = repositoryOf({
			entity: Reassignable,
			actions: ["findById", "update"],
		});
		expect(make("update", Items, { owner: { context: "userId" } })).toContain(
			'"ownerId"',
		);
		// without owner, nothing to protect
		expect(() => loose.update?.(Items)).not.toThrow();
	});
});

describe("SEC-10: list caps its limit", () => {
	const Memos = repositoryOf({
		entity: Memo,
		provider: inMemoryProvider(),
		actions: ["findPage"],
	});
	const C = commandOf({
		name: "C",
		useCases: (ctx) => ({
			list: ctx.list(Memos),
			small: ctx.list(Memos, { name: "Small", maxLimit: 5 }),
		}),
	});

	test("SEC-10: a limit above maxLimit (100 by default) is invalid input", async () => {
		const error = await failure(C.run("list", { limit: 1_000_000_000 }));
		expect(error.name).toBe("InvalidUseCaseInput");
		expect(statusOf(error)).toBe(400);
		const issues = (error.trace ?? []).flatMap(
			(frame) => frame.details?.issues ?? [],
		);
		expect(issues.map((issue) => issue.code)).toEqual(["invalid_value"]);
		expect((await C.run("list", { limit: 100 })).limit).toBe(100);
		expect((await failure(C.run("small", { limit: 6 }))).name).toBe(
			"InvalidUseCaseInput",
		);
		expect((await C.run("small", { limit: 5 })).limit).toBe(5);
	});

	test("SEC-10: maxLimit is a whole number above 0", () => {
		expect(make("list", Memos, { maxLimit: 0 })).toContain("maxLimit");
		expect(make("list", Memos, { maxLimit: 1.5 })).toContain("maxLimit");
	});
});

describe("SEC-11: login takes as long for an unknown email", () => {
	afterEach(() => resetRuntime());

	test("SEC-11: an unknown email still verifies a password, against a dummy hash made once", async () => {
		const real = currentHasher();
		const calls = { hash: 0, verify: 0 };
		configure({
			hasher: {
				hash: (plain) => {
					calls.hash++;
					return real.hash(plain);
				},
				verify: (plain, hash) => {
					calls.verify++;
					return real.verify(plain, hash);
				},
			},
		});
		const Users = repositoryOf({
			entity: User,
			provider: inMemoryProvider(),
			actions: ["findByEmail", "create"],
		});
		const A = commandOf({
			name: "A",
			useCases: (ctx) => ({
				register: ctx.register(Users),
				login: ctx.login(Users),
			}),
		});
		await A.run("register", {
			name: "a",
			email: "exists@x.io",
			password: strong,
		});
		calls.hash = 0;

		const known = await failure(
			A.run("login", { email: "exists@x.io", password: "Wrong@123" }),
		);
		expect(known.name).toBe("UseCaseInvalidCredentials");
		expect(calls).toEqual({ hash: 0, verify: 1 });

		for (let round = 1; round <= 2; round++) {
			const unknown = await failure(
				A.run("login", { email: "nobody@x.io", password: "Wrong@123" }),
			);
			expect(unknown.name).toBe("UseCaseInvalidCredentials");
			expect(unknown.message).toBe(known.message);
			// the dummy hash is made on the first unknown email only
			expect(calls).toEqual({ hash: 1, verify: 1 + round });
		}
	});
});
