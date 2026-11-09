import type { ResolvedSpec, Spec } from "../../../src";

/** The spec another one extends: accounts with the authenticatable plugin. */
export const authSpec: Spec = {
	version: 1,
	name: "auth",
	output: { dir: "src/auth" },
	provider: "inMemory",
	properties: { Handle: { base: "slug", with: { max: 20 } } },
	entities: {
		Account: {
			fields: { name: "text", handle: "Handle?" },
			plugins: ["authenticatable"],
		},
	},
	repositories: {
		Accounts: {
			entity: "Account",
			actions: ["findById", "findByEmail", "create"],
		},
	},
};

/**
 * Domain: refined, enum and opaque properties, nested blueprints, lists and
 * optionals, records and entities with every option, std plugins, an entity of
 * the extended spec, an environment and repositories with soft deletion and
 * every query action.
 */
export const librarySpec: Spec = {
	version: 1,
	name: "library",
	output: { dir: "src/library" },
	extends: ["../auth/afora.json"],
	provider: "inMemory",
	properties: {
		Pages: {
			base: "integer",
			with: { min: 1, max: 5000, description: "Page count" },
		},
		LongBook: { base: "Pages", with: { min: 300 } },
		MaybePages: { base: "Pages", optional: true },
		Status: { enum: ["draft", "published"] },
		Level: { enum: [1, 2, 3], name: "level", default: 2 },
		Rating: {
			opaque: true,
			ref: "Rating",
			import: "../support/rating",
		},
	},
	blueprints: {
		Address: {
			fields: {
				street: "string",
				zip: { type: "string", with: { pattern: "^\\d{5}$" } },
				geo: { fields: { lat: "number", lng: "number" }, optional: true },
			},
		},
		Shelf: { fields: { address: "Address?", addresses: "Address[]" } },
	},
	records: {
		Money: {
			fields: {
				amount: { type: "number", with: { min: 0 } },
				currency: { enum: ["USD", "BRL"] },
			},
			change: ["amount"],
		},
		Secret: {
			fields: { token: "string", hint: "text?" },
			sensitive: ["token"],
		},
		Note: { fields: { body: "text" }, plugins: ["archivable"] },
	},
	entities: {
		Book: {
			fields: {
				title: "text",
				isbn: "slug",
				status: "Status",
				level: "Level",
				pages: "Pages",
				long: "LongBook?",
				maybe: "MaybePages",
				rating: "Rating?",
				price: "Money",
				secret: "Secret?",
				note: "Note?",
				shelf: "Shelf",
				kinds: { enum: ["novel", "essay"], list: true, optional: true },
				notes: { type: "text", optional: true, with: { max: 200 } },
				nested: { fields: { deep: { fields: { x: "integer" } } } },
				scores: "Pages[]",
				labels: { type: "Status", list: { minItems: 1, maxItems: 3 } },
				reviewer: "Account",
			},
			unique: ["isbn"],
			sensitive: ["notes"],
			change: ["notes", "level"],
			plugins: ["taggable", "publishable"],
		},
	},
	environments: {
		Library: {
			fields: {
				SHELF_LIMIT: "integer",
				MODE: { enum: ["dev", "prod"] },
				KEY: "string?",
			},
		},
	},
	repositories: {
		Books: {
			entity: "Book",
			actions: [
				"findById",
				"findByIsbn",
				"findManyByLevel",
				"findManyByReviewer",
				"findMany",
				"exists",
				"findPage",
				"count",
				"create",
				"update",
				"delete",
			],
			deletion: "soft",
			relations: ["Accounts"],
			environments: ["Library"],
		},
	},
};

export const libraryContext: Record<string, ResolvedSpec> = {
	"../auth/afora.json": { spec: authSpec },
};
