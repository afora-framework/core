import type { ResolvedSpec, Spec } from "../src/spec/types";

/** The README quick start: a record with a sensitive password and a unique email. */
export const quickstartSpec: Spec = {
	version: 1,
	name: "quickstart",
	output: { dir: "src/domain" },
	blueprints: {
		Address: { fields: { street: "string", zip: "string" } },
	},
	records: {
		User: {
			fields: {
				email: "email",
				slug: "slug",
				password: "password",
				address: "Address",
				tags: { type: "string", list: { maxItems: 5 } },
			},
			unique: ["email"],
			change: ["password"],
		},
	},
};

/** A blog: custom properties, a blueprint, entities with relations, an environment and repositories. */
export const blogSpec: Spec = {
	version: 1,
	name: "blog",
	output: { dir: "src/domain" },
	properties: {
		Age: {
			base: "integer",
			with: { min: 0, max: 150, description: "In years" },
		},
		Status: { enum: ["draft", "published"] },
	},
	blueprints: {
		Address: {
			fields: {
				street: "string",
				zip: { type: "string", with: { pattern: "^\\d{5}-\\d{3}$" } },
			},
		},
	},
	entities: {
		User: {
			fields: {
				name: "text",
				email: "email",
				slug: "slug",
				password: "password",
				age: "Age?",
				address: "Address",
				tags: "string[]",
			},
			unique: ["email"],
			change: ["name"],
		},
		Post: {
			fields: {
				title: "text",
				status: "Status",
				author: "User",
				coauthors: "User[]",
			},
		},
	},
	environments: {
		Database: { fields: { DATABASE_URL: "url", PORT: "integer" } },
	},
	repositories: {
		Users: {
			entity: "User",
			actions: ["findById", "findByEmail", "findBySlug", "create", "update"],
			environments: ["Database"],
		},
		Posts: {
			entity: "Post",
			actions: ["findById", "findManyByAuthor", "create"],
			relations: ["Users"],
		},
	},
};

/** A spec another one extends. */
export const authSpec: Spec = {
	version: 1,
	name: "auth",
	output: { dir: "src/auth" },
	entities: {
		Account: {
			fields: { name: "text" },
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

/** A blog whose posts belong to the accounts of `authSpec`. */
export const extendsSpec: Spec = {
	version: 1,
	name: "journal",
	output: { dir: "src/journal" },
	extends: ["../auth/afora.json"],
	entities: {
		Entry: {
			fields: { title: "text", owner: "Account", tags: "string[]?" },
		},
	},
	repositories: {
		Entries: {
			entity: "Entry",
			actions: ["findById", "findManyByOwner", "create"],
			relations: ["Accounts"],
		},
	},
};

export const extendsContext: Record<string, ResolvedSpec> = {
	"../auth/afora.json": { spec: authSpec },
};

/** Exercises every form the spec has. */
export const kitchenSpec: Spec = {
	version: 1,
	name: "kitchen",
	output: { dir: "gen" },
	properties: {
		Age: {
			base: "integer",
			with: { min: 0, max: 150, description: "In years" },
		},
		Adult: { base: "Age", with: { min: 18 } },
		MaybeAge: { base: "Age", optional: true },
		Status: { enum: ["draft", "published"] },
		Level: { enum: [1, 2, 3], name: "level", default: 2 },
		Handle: { base: "slug", with: { max: 20 } },
	},
	blueprints: {
		Address: {
			fields: {
				street: "string",
				zip: { type: "string", with: { pattern: "^\\d{5}$" } },
				geo: { fields: { lat: "number", lng: "number" }, optional: true },
			},
		},
		Box: { fields: { address: "Address?", addresses: "Address[]" } },
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
	},
	entities: {
		Account: {
			fields: { name: "text" },
			plugins: ["authenticatable", "taggable"],
			unique: ["name"],
		},
		Profile: {
			fields: {
				handle: "Handle",
				age: "Adult?",
				maybe: "MaybeAge",
				level: "Level",
				labels: { type: "Status", list: { minItems: 1, maxItems: 3 } },
				price: "Money",
				secret: "Secret?",
				account: "Account",
				box: "Box",
				kinds: { enum: ["a", "b"], list: true, optional: true },
				notes: { type: "text", optional: true, with: { max: 200 } },
				nested: { fields: { deep: { fields: { x: "integer" } } } },
				scores: "Age[]",
				mood: { enum: ["happy", "sad"], optional: true },
			},
			unique: ["handle"],
			sensitive: ["notes"],
			change: ["notes", "level"],
		},
	},
	environments: {
		Env: {
			fields: {
				PORT: "integer",
				MODE: { enum: ["dev", "prod"] },
				KEY: "string?",
			},
		},
	},
	repositories: {
		Accounts: {
			entity: "Account",
			actions: [
				"findById",
				"findByEmail",
				"findByName",
				"create",
				"update",
				"delete",
				"count",
			],
			environments: ["Env"],
		},
		Profiles: {
			entity: "Profile",
			actions: [
				"findById",
				"findByHandle",
				"findManyByLevel",
				"findManyByAccount",
				"create",
			],
			relations: ["Accounts"],
		},
	},
};
