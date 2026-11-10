import { expect, expectTypeOf, test } from "bun:test";
import type { IRepositoryProvider, RepositoryContext } from "../../adapters";
import {
	blueprintOf,
	Exception,
	entityOf,
	InvalidRecordDeclaration,
	inMemoryProvider,
	recordNameOf,
	recordOf,
	repositoryOf,
} from "../../index";

const Person = blueprintOf((ctx) => ({ name: ctx.string }));

/** What a minifier does to a class: it gets another `name`. */
function minified<Class extends object>(Class: Class): Class {
	Object.defineProperty(Class, "name", { value: "a" });
	return Class;
}

/** An in-memory provider that keeps the contexts it was called with. */
function recording() {
	const contexts: RepositoryContext[] = [];
	const memory = inMemoryProvider();
	const provider: IRepositoryProvider = {
		...memory,
		insert: (context, data) => {
			contexts.push(context);
			return memory.insert(context, data);
		},
	};
	return { provider, contexts };
}

test("without a name, the name of the class is the record name", () => {
	class User extends recordOf(Person) {}
	class Admin extends User {}

	expect(recordNameOf(User)).toBe("User");
	expect(User.recordName).toBe("User");
	expect(recordNameOf(Admin)).toBe("Admin");
	expect(recordNameOf(recordOf(Person))).toBe("record");
	expect(recordNameOf(entityOf(Person))).toBe("entity");
	expectTypeOf(User.recordName).toEqualTypeOf<string>();
});

test("a declared name survives the renaming of the class", () => {
	const User = minified(
		class User extends recordOf(Person, { name: "User" }) {},
	);
	const Account = minified(
		class Account extends entityOf(Person, { name: "Account" }) {},
	);
	const Admin = minified(class Admin extends Account {});

	expect(User.name).toBe("a");
	expect(recordNameOf(User)).toBe("User");
	expect(User.recordName).toBe("User");
	expect(recordNameOf(Account)).toBe("Account");
	// A subclass keeps the declared name, unless it gives its own.
	expect(recordNameOf(Admin)).toBe("Account");
	class Owner extends Account {
		static override readonly recordName = "Owner";
	}
	expect(recordNameOf(Owner)).toBe("Owner");
	// The class `recordOf` returns is named too, for stack traces.
	expect(recordOf(Person, { name: "User" }).name).toBe("User");
});

test("exceptions name the record by its declared name", () => {
	const User = minified(
		class User extends recordOf(Person, { name: "User" }) {},
	);
	let error: unknown;
	try {
		new User({ name: 1 as never });
	} catch (caught) {
		error = caught;
	}

	expect(error).toBeInstanceOf(Exception);
	expect((error as Exception).source).toBe("User");
});

test("the context of a repository uses the declared name", async () => {
	const Account = minified(
		class Account extends entityOf(Person, { name: "Account" }) {},
	);
	const { provider, contexts } = recording();
	const Accounts = repositoryOf({
		entity: Account,
		actions: ["create"],
		provider,
	});

	await Accounts.create(new Account({ name: "Ana" }));

	expect(contexts).toHaveLength(1);
	expect(contexts[0]?.name).toBe("AccountRepository");
	expect(recordNameOf(contexts[0]?.entity as object)).toBe("Account");
});

test("a name that is not an identifier is rejected", () => {
	for (const name of ["", "my user", "1st", "a-b"]) {
		expect(() => recordOf(Person, { name })).toThrow(InvalidRecordDeclaration);
		expect(() => entityOf(Person, { name })).toThrow(InvalidRecordDeclaration);
	}
	expect(() => recordOf(Person, { name: 1 as never })).toThrow(
		InvalidRecordDeclaration,
	);
});
