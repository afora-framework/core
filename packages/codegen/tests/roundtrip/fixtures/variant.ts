import type { Spec } from "../../../src";

/**
 * Variant fields: of blueprints (one declared in place), of a record, of an
 * entity (its repository has the relation), optional and in a list.
 */
export const variantSpec: Spec = {
	version: 1,
	name: "payments",
	output: { dir: "src/payments" },
	provider: "inMemory",
	blueprints: {
		Click: { fields: { target: "string" } },
		Signup: { fields: { email: "email", plan: "string?" } },
		Pix: { fields: { key: "string" } },
	},
	records: {
		Card: {
			fields: { last4: "string", holder: "text" },
			sensitive: ["holder"],
		},
	},
	entities: {
		Wallet: { fields: { owner: "text" } },
		Payment: {
			fields: {
				event: {
					variant: {
						key: "type",
						of: {
							click: "Click",
							signup: "Signup",
							visit: { fields: { path: "string" } },
						},
					},
				},
				method: {
					variant: { key: "method", of: { card: "Card", pix: "Pix" } },
				},
				source: {
					variant: {
						key: "kind",
						of: { wallet: "Wallet", cash: { fields: { amount: "number" } } },
					},
					optional: true,
				},
				history: {
					variant: { key: "type", of: { click: "Click", signup: "Signup" } },
					list: { maxItems: 3 },
				},
				// Too long for one line: every argument of listOf on its own.
				attempts: {
					variant: {
						key: "type",
						of: { clickedSomewhere: "Click", signedUpForNewsletter: "Signup" },
					},
					list: { maxItems: 10 },
					optional: true,
				},
			},
		},
	},
	repositories: {
		Wallets: { entity: "Wallet", actions: ["findById", "create"] },
		Payments: {
			entity: "Payment",
			actions: ["findById", "create", "update"],
			relations: ["Wallets"],
		},
	},
};
