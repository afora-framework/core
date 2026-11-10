import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	enumOf,
	environmentOf,
	exceptionOf,
	Integer,
	openapi,
	outputOf,
	repositoryOf,
	select,
	useCaseOf,
} from "@afora/core";
import { discounted } from "../support/pricing";
import { memoryProvider } from "../support/providers";
import { keepAll, labeler } from "../support/stages";

/**
 * A hand-written application (no codegen) with a catalog provider, soft
 * deletion, an environment, a hand-written `execute`, a `run` function and
 * outputs with a stage written by hand.
 */
const UnknownProduct = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UnknownProduct",
	message: "No such product.",
});

const Price = Integer.with({ min: 0, description: "In cents" });
const Status = enumOf(["draft", "published"]);
const Dims = blueprintOf((ctx) => ({ w: ctx.number, h: ctx.number }));

class Product extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		sku: ctx.slug,
		price: Price,
		status: Status,
		dims: Dims,
	})),
	{ unique: ["sku"], change: ["price"] },
) {}
class Order extends entityOf(
	blueprintOf((ctx) => ({ product: Product, quantity: ctx.integer })),
) {}

const Settings = environmentOf(
	blueprintOf((ctx) => ({ CURRENCY: ctx.string, PORT: ctx.integer })),
);

const Products = repositoryOf({
	entity: Product,
	actions: [
		"findById",
		"findBySku",
		"findMany",
		"exists",
		"findPage",
		"count",
		"create",
		"delete",
	],
	deletion: "soft",
	environmentDependencies: [Settings],
});
const Orders = repositoryOf({
	entity: Order,
	actions: ["findById", "findManyByProduct", "create"],
	relations: [Products],
	provider: memoryProvider({ label: "orders" }),
});

const ProductInput = blueprintOf((ctx) => ({
	name: ctx.text,
	sku: ctx.slug,
	price: Price,
	status: Status,
	dims: Dims,
}));

const AddProduct = useCaseOf({
	name: "AddProduct",
	description: "Adds a product.",
	blueprint: ProductInput,
	response: blueprintOf(() => ({ product: Product })),
	dependencies: { products: Products },
	steps: [
		{
			build: Product,
			values: {
				name: "$input.name",
				sku: "$input.sku",
				price: "$input.price",
				status: "$input.status",
				dims: "$input.dims",
			},
			as: "product",
		},
		{ create: "products", value: "$product", as: "saved" },
		{ return: { product: "$saved" } },
	],
});

const PlaceOrder = useCaseOf({
	name: "PlaceOrder",
	blueprint: blueprintOf((ctx) => ({ sku: ctx.slug, quantity: ctx.integer })),
	response: blueprintOf(() => ({ order: Order })),
	dependencies: { products: Products, orders: Orders },
	errors: [UnknownProduct],
	steps: [
		{ find: "products.findBySku", args: ["$input.sku"], as: "product" },
		{ ensure: "exists", value: "$product", error: UnknownProduct },
		{
			build: Order,
			values: { product: "$product", quantity: "$input.quantity" },
			as: "order",
		},
		{ create: "orders", value: "$order", as: "saved" },
		{ return: { order: "$saved" } },
	],
});

const Sale = useCaseOf({
	name: "Sale",
	blueprint: blueprintOf((ctx) => ({ sku: ctx.slug, percent: ctx.integer })),
	response: blueprintOf((ctx) => ({ price: ctx.integer })),
	dependencies: { products: Products },
	errors: [UnknownProduct],
	steps: [
		{ find: "products.findBySku", args: ["$input.sku"], as: "product" },
		{ ensure: "exists", value: "$product", error: UnknownProduct },
		{
			run: "discounted",
			fn: discounted,
			args: ["$product.price", "$input.percent"],
			as: "price",
		},
		{ return: { price: "$price" } },
	],
});

class Echo extends useCaseOf({
	name: "Echo",
	blueprint: blueprintOf((ctx) => ({ text: ctx.text })),
	response: blueprintOf((ctx) => ({ echo: ctx.string })),
}) {
	async execute() {
		return { echo: [...this.input.text].reverse().join("") };
	}
}

const ShopCommand = commandOf({
	name: "Shop",
	description: "The public shop.",
	tags: ["public"],
	useCases: {
		addProduct: AddProduct,
		placeOrder: PlaceOrder,
		sale: Sale,
		echo: Echo,
	},
});
const Admin = commandOf({
	name: "Admin",
	tags: ["private"],
	useCases: { addProduct: AddProduct },
	transaction: true,
});

const Api = outputOf({
	name: "Api",
	commands: [ShopCommand, Admin],
	statuses: { UnknownProduct: 404 },
	pipe: [
		select({ tags: ["public"] }),
		labeler({ tag: "api" }),
		openapi({ info: { title: "Storefront", version: "2.0.0" } }),
	],
});
const Manual = outputOf({
	name: "Manual",
	commands: [ShopCommand],
	pipe: [keepAll],
});

export const StorefrontApp = applicationOf({
	name: "storefront",
	provider: memoryProvider({ label: "main" }),
	properties: { Price, Status },
	blueprints: { Dims, ProductInput },
	entities: { Product, Order },
	environments: { Settings },
	repositories: { Products, Orders },
	exceptions: { UnknownProduct },
	useCases: { AddProduct, PlaceOrder, Sale, Echo },
	commands: { Shop: ShopCommand, Admin },
	outputs: { Api, Manual },
});
