import type {
	ProviderCatalogEntry,
	Spec,
	StageCatalogEntry,
} from "../../../src";

/** The test catalogs: a provider and a stage that are not built in. */
const SHOP_PROVIDERS: ProviderCatalogEntry[] = [
	{ name: "memory", module: "../support/providers", export: "memoryProvider" },
];
const SHOP_STAGES: StageCatalogEntry[] = [
	{
		name: "label",
		module: "../support/stages",
		export: "labeler",
		kind: "transform",
	},
];
export const SHOP_OPTIONS = { providers: SHOP_PROVIDERS, stages: SHOP_STAGES };

export const SHOP_IMPORTS = {
	"repositories.Audit.provider": "../support/anonymous-provider#anonymous",
	"outputs.Manual.pipe.0": "../support/stages#keepAll",
};

/**
 * Providers (the application's from the catalog, a repository's own, an
 * imported one) and outputs: `select`, a catalog stage, `openapi`, statuses and
 * a stage written by hand.
 */
export const shopSpec: Spec = {
	version: 1,
	name: "shop",
	output: { dir: "src/shop" },
	provider: { use: "memory", options: { label: "main" } },
	entities: {
		Product: {
			fields: { name: "text", sku: "slug", price: "number" },
			unique: ["sku"],
		},
		Order: {
			fields: { product: "Product", quantity: "integer" },
		},
		Entry: { fields: { message: "string" } },
	},
	repositories: {
		Products: {
			entity: "Product",
			actions: ["findById", "findBySku", "findMany", "create"],
		},
		Orders: {
			entity: "Order",
			actions: ["findById", "findManyByProduct", "create"],
			relations: ["Products"],
			provider: { use: "memory", options: { label: "orders" } },
		},
		Audit: {
			entity: "Entry",
			actions: ["create", "findMany"],
			provider: { import: "../support/anonymous-provider#anonymous" },
		},
	},
	exceptions: {
		UnknownProduct: { layer: "use-case", message: "No such product." },
	},
	useCases: {
		AddProduct: {
			description: "Adds a product.",
			input: { fields: { name: "text", sku: "slug", price: "number" } },
			response: { fields: { product: "Product" } },
			dependencies: { products: "Products", audit: "Audit" },
			implementation: {
				steps: [
					{
						build: "Product",
						values: {
							name: "$input.name",
							sku: "$input.sku",
							price: "$input.price",
						},
						as: "product",
					},
					{ create: "products", value: "$product", as: "saved" },
					{
						build: "Entry",
						values: { message: "$input.sku" },
						as: "entry",
					},
					{ create: "audit", value: "$entry" },
					{ return: { product: "$saved" } },
				],
			},
		},
		PlaceOrder: {
			description: "Places an order.",
			input: { fields: { sku: "slug", quantity: "integer" } },
			response: { fields: { order: "Order" } },
			dependencies: { products: "Products", orders: "Orders" },
			errors: ["UnknownProduct"],
			implementation: {
				steps: [
					{ find: "products.findBySku", args: ["$input.sku"], as: "product" },
					{ ensure: "exists", value: "$product", error: "UnknownProduct" },
					{
						build: "Order",
						values: { product: "$product", quantity: "$input.quantity" },
						as: "order",
					},
					{ create: "orders", value: "$order", as: "saved" },
					{ return: { order: "$saved" } },
				],
			},
		},
	},
	commands: {
		Shop: {
			description: "The public shop.",
			tags: ["public"],
			useCases: { addProduct: "AddProduct", placeOrder: "PlaceOrder" },
			transaction: false,
		},
		Admin: {
			tags: ["private"],
			useCases: { addProduct: "AddProduct" },
		},
	},
	outputs: {
		Api: {
			commands: ["Shop", "Admin"],
			statuses: { UnknownProduct: 404, RepositoryUniqueViolation: 409 },
			pipe: [
				{ transform: "select", options: { tags: ["public"] } },
				{ transform: "label", options: { tag: "api" } },
				{
					sink: "openapi",
					options: { info: { title: "Shop", version: "1.0.0" } },
				},
			],
		},
		Plain: { commands: ["Admin"], pipe: [] },
		Manual: {
			commands: ["Shop"],
			pipe: [{ import: "../support/stages#keepAll" }],
		},
	},
};
