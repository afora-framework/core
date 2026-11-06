import { afterAll, describe, expect, test } from "bun:test";
import { Password } from "@afora/core";
import { extractSpec, validateSpec } from "../../src";
import { authSpec, libraryContext, librarySpec } from "./fixtures/library";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

const layouts = [
	{ root: "auth", spec: authSpec },
	{ root: "library", spec: librarySpec, extended: libraryContext },
];

const caught = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string }) => error.name,
	);

/** Drives the generated library: entities, relations, soft deletion, queries, plugins, the environment. */
async function behave(App: Any) {
	process.env.SHELF_LIMIT = "10";
	process.env.MODE = "dev";
	const { Books, Accounts } = App.repositories;
	const env = await App.environments.Library.load();

	const ana = await Accounts.create({
		name: "Ana",
		email: "ana@example.com",
		password: (await Password.hash("Str0ng-pass!")).value,
	});
	const draft = (isbn: string, level: number, extra: object = {}) => ({
		title: `Book ${isbn}`,
		isbn,
		status: "draft",
		level,
		pages: 400,
		maybe: 3,
		price: { amount: 10, currency: "USD" },
		shelf: { addresses: [{ street: "Main", zip: "12345" }] },
		nested: { deep: { x: 1 } },
		scores: [1, 2],
		labels: ["draft"],
		reviewer: ana,
		...extra,
	});
	const one = await Books.create(
		draft("b-1", 2, {
			notes: "private",
			rating: 9,
			note: { body: "first" },
			secret: { token: "t0k" },
		}),
	);
	const two = await Books.create(draft("b-2", 3));
	await Books.create(draft("b-3", 3));

	const found = await Books.findById(one.id);
	const json = found.toJSON();
	const invalid = {
		zip: await caught(
			Books.create(
				draft("b-9", 1, { shelf: { addresses: [{ street: "x", zip: "1" }] } }),
			),
		),
		rating: await caught(Books.create(draft("b-9", 1, { rating: 4.6 }))),
		pages: await caught(Books.create(draft("b-9", 1, { long: 10 }))),
		labels: await caught(Books.create(draft("b-9", 1, { labels: [] }))),
		duplicate: await caught(Books.create(draft("b-1", 1))),
	};

	one.change.notes("changed");
	one.change.level(1);
	one.price.change.amount(25);
	one.tag("classic", "classic");
	one.publish("2026-01-01T00:00:00.000Z");
	await Books.update(one);
	const updated = await Books.findByIsbn("b-1");

	const level3 = await Books.findManyByLevel(3);
	const byReviewer = await Books.findManyByReviewer(ana.id);
	const ordered = await Books.findMany({
		where: { level: { in: [1, 3] } },
		orderBy: [{ key: "isbn", direction: "desc" }],
	});
	const page = await Books.findPage({ orderBy: [{ key: "isbn" }], limit: 2 });

	await Books.delete(two.id);
	const afterDelete = {
		byId: await Books.findById(two.id),
		count: await Books.count(),
		exists: await Books.exists({ where: { isbn: "b-2" } }),
		reuse: await caught(Books.create(draft("b-2", 3))),
	};

	return {
		env,
		json: {
			rating: json.rating,
			notes: json.notes,
			reviewer: json.reviewer.name,
			password: json.reviewer.password,
			note: json.note,
			secret: json.secret.token,
		},
		invalid,
		updated: {
			notes: updated.toJSON().notes,
			level: updated.level,
			amount: updated.price.amount,
			tags: updated.tags,
			published: updated.isPublished,
		},
		level3: level3.map((book: Any) => book.isbn),
		byReviewer: byReviewer.length,
		ordered: ordered.map((book: Any) => book.isbn),
		page: {
			items: page.items.map((book: Any) => book.isbn),
			total: page.total,
		},
		afterDelete: { ...afterDelete, byId: afterDelete.byId === undefined },
	};
}

const EXPECTED = {
	env: { SHELF_LIMIT: 10, MODE: "dev" },
	json: {
		rating: 5,
		notes: "********",
		reviewer: "Ana",
		password: "********",
		note: { body: "first" },
		secret: "********",
	},
	invalid: {
		zip: "InvalidPropertyValue",
		rating: "InvalidPropertyValue",
		pages: "InvalidPropertyValue",
		labels: "InvalidRecordValue",
		duplicate: "RepositoryUniqueViolation",
	},
	updated: {
		notes: "********",
		level: 1,
		amount: 25,
		tags: ["classic"],
		published: true,
	},
	level3: ["b-2", "b-3"],
	byReviewer: 3,
	ordered: ["b-3", "b-2", "b-1"],
	page: { items: ["b-1", "b-2"], total: 3 },
	afterDelete: {
		byId: true,
		count: 2,
		exists: false,
		reuse: "RepositoryUniqueViolation",
	},
};

describe("JSON -> app -> JSON: library", () => {
	test("the specs are valid", () => {
		expect(validateSpec(authSpec)).toEqual([]);
		expect(validateSpec(librarySpec, libraryContext)).toEqual([]);
	});

	test("generates clean code, behaves and extracts to the same spec", async () => {
		const project = await buildProject(layouts);
		await lintAndTypecheck(project);
		const { App } = project.domains.library as Any;
		expect(await behave(App)).toEqual(EXPECTED);

		const extracted = extractSpec(App, {
			outputDir: "src/library",
			extends: { auth: "../auth/afora.json" },
			imports: { Rating: "../support/rating" },
		});
		expect(validateSpec(extracted, libraryContext)).toEqual([]);
		expect(canonical(extracted, libraryContext)).toEqual(
			canonical(librarySpec, libraryContext),
		);
		const base = extractSpec(project.domains.auth.App, {
			outputDir: "src/auth",
		});
		expect(canonical(base)).toEqual(canonical(authSpec));
	}, 180_000);
});
