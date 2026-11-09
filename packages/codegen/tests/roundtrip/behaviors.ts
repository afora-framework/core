import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import type { Any } from "./harness";

/**
 * Behavior shared by the hand-written applications and the code generated from
 * their extracted specs: the same functions run against both.
 */
const caught = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string; message: string }) => error,
	);

/** Registers, rejects a duplicate, logs in with context, rates, greets and handles events. */
export async function accountsBehavior(App: Any) {
	const { Accounts, Notifier, Alerts } = App.commands;
	const input = { name: "Ana", email: "ana@example.com", plainPassword: "pw" };
	const session = (requestId: string) => ({ context: { requestId } });

	const registered = await Accounts.run("register", input, session("r1"));
	const duplicate = await caught(
		Accounts.run("register", input, session("r2")),
	);
	const login = await Accounts.run(
		"login",
		{ email: input.email, plainPassword: "pw" },
		session("r3"),
	);
	const wrong = await caught(
		Accounts.run(
			"login",
			{ email: input.email, plainPassword: "nope" },
			session("r4"),
		),
	);
	const rated = await Accounts.run(
		"rate",
		{ email: input.email, stars: 4 },
		session("r5"),
	);
	const unknown = await caught(
		Accounts.run(
			"rate",
			{ email: "ghost@example.com", stars: 1 },
			session("r6"),
		),
	);
	const greeting = await Accounts.run("greet", { name: "Bia" }, session("r7"));
	await Notifier.run("register", { ...input, email: "notify@example.com" });
	await Alerts.run("signUp", { ...input, email: "alert@example.com" });

	const direct = await App.repositories.Users.create({
		name: "Caio",
		email: "caio@example.com",
		hash: "h",
		rating: 9,
	});
	return {
		registered: {
			name: registered.user.name,
			hash: registered.user.toJSON().hash,
		},
		duplicate: {
			name: duplicate?.name,
			message: duplicate?.message,
		},
		login: { email: login.user.email, requestId: login.requestId },
		wrong: wrong?.name,
		rated: rated.user.name,
		unknown: unknown?.name,
		greeting: greeting.greeting,
		rating: direct.toJSON().rating,
		ratingRejected: (
			await caught(
				App.repositories.Users.create({
					name: "D",
					email: "d@example.com",
					hash: "h",
					rating: 2.5,
				}),
			)
		)?.name,
		users: await App.repositories.Users.count(),
	};
}

export const ACCOUNTS_EXPECTED = {
	registered: { name: "Ana", hash: "********" },
	duplicate: {
		name: "UserAlreadyExists",
		message: "A user with this email already exists.",
	},
	login: { email: "ana@example.com", requestId: "r3" },
	wrong: "InvalidCredentials",
	rated: "Ana (4 stars)",
	unknown: "InvalidCredentials",
	greeting: "Hello, Bia!",
	rating: 5,
	ratingRejected: "InvalidPropertyValue",
	users: 4,
};

/** Adds products, orders and sales, soft-deletes, queries and builds the OpenAPI document. */
export async function storefrontBehavior(App: Any) {
	process.env.CURRENCY = "BRL";
	process.env.PORT = "3000";
	const { Shop, Admin } = App.commands;
	const { Products, Orders } = App.repositories;
	const lamp = {
		name: "Lamp",
		sku: "lamp",
		price: 1000,
		status: "draft",
		dims: { w: 1, h: 2 },
	};
	const added = await Shop.run("addProduct", lamp);
	await Admin.run("addProduct", {
		...lamp,
		name: "Desk",
		sku: "desk",
		status: "published",
	});
	const duplicate = await caught(Shop.run("addProduct", lamp));
	const order = await Shop.run("placeOrder", { sku: "lamp", quantity: 2 });
	const unknown = await caught(
		Shop.run("placeOrder", { sku: "ghost", quantity: 1 }),
	);
	const sale = await Shop.run("sale", { sku: "lamp", percent: 25 });
	const echo = await Shop.run("echo", { text: "abc" });

	const stored = (await Orders.findManyByProduct(added.product.id)).length;
	const drafts = await Products.findMany({ where: { status: "draft" } });
	const page = await Products.findPage({ orderBy: [{ key: "sku" }], limit: 1 });
	await Products.delete(added.product.id);
	const afterDelete = {
		found: (await Products.findById(added.product.id)) === undefined,
		count: await Products.count(),
		exists: await Products.exists({ where: { sku: "lamp" } }),
		reuse: (await caught(Products.create(lamp)))?.name,
	};

	const { Api, Manual } = App.outputs;
	const document = Api.build();
	const validation = await new Validator().validate(document as SpecData);
	return {
		env: await App.environments.Settings.load(),
		duplicate: duplicate?.name,
		order: {
			sku: order.order.product.sku,
			quantity: order.order.quantity,
			stored,
		},
		unknown: unknown?.name,
		sale: sale.price,
		echo: echo.echo,
		drafts: drafts.map((product: Any) => product.sku),
		page: { items: page.items.map((p: Any) => p.sku), total: page.total },
		afterDelete,
		operations: Api.operations.map((operation: Any) => ({
			id: operation.id,
			tags: operation.tags,
		})),
		paths: Object.keys(document.paths),
		info: document.info,
		notFound: Object.keys(document.paths["/shop/place-order"].post.responses),
		valid: validation.valid,
		manual: Manual.operations.map((operation: Any) => operation.id),
	};
}

export const STOREFRONT_EXPECTED = {
	env: { CURRENCY: "BRL", PORT: 3000 },
	duplicate: "RepositoryUniqueViolation",
	order: { sku: "lamp", quantity: 2, stored: 1 },
	unknown: "UnknownProduct",
	sale: 750,
	echo: "cba",
	drafts: ["lamp"],
	page: { items: ["desk"], total: 2 },
	afterDelete: {
		found: true,
		count: 1,
		exists: false,
		reuse: "RepositoryUniqueViolation",
	},
	operations: [
		{ id: "Shop.addProduct", tags: ["public", "api"] },
		{ id: "Shop.placeOrder", tags: ["public", "api"] },
		{ id: "Shop.sale", tags: ["public", "api"] },
		{ id: "Shop.echo", tags: ["public", "api"] },
	],
	paths: ["/shop/add-product", "/shop/place-order", "/shop/sale", "/shop/echo"],
	info: { title: "Storefront", version: "2.0.0" },
	notFound: ["200", "400", "404", "500"],
	valid: true,
	manual: ["Shop.addProduct", "Shop.placeOrder", "Shop.sale", "Shop.echo"],
};
