import { afterAll, describe, expect, test } from "bun:test";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { extractSpec, validateSpec } from "../../src";
import { SHOP_IMPORTS, SHOP_OPTIONS, shopSpec } from "./fixtures/shop";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

const caught = async (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: { name: string }) => error.name,
	);

/** Runs the shop's commands and builds the outputs. */
async function behave(App: Any) {
	const { Shop, Admin } = App.commands;
	const added = await Shop.run("addProduct", {
		name: "Lamp",
		sku: "lamp",
		price: 10,
	});
	await Admin.run("addProduct", { name: "Desk", sku: "desk", price: 99 });
	const duplicate = await caught(
		Shop.run("addProduct", { name: "Lamp", sku: "lamp", price: 10 }),
	);
	const order = await Shop.run("placeOrder", { sku: "lamp", quantity: 2 });
	const unknown = await caught(
		Shop.run("placeOrder", { sku: "ghost", quantity: 1 }),
	);

	const { Api, Plain, Manual } = App.outputs;
	const document = Api.build();
	const validation = await new Validator().validate(document as SpecData);
	return {
		added: added.product.sku,
		duplicate,
		order: { sku: order.order.product.sku, quantity: order.order.quantity },
		unknown,
		audited: (await App.repositories.Audit.findMany()).length,
		operations: Api.operations.map((operation: Any) => ({
			id: operation.id,
			tags: operation.tags,
		})),
		paths: Object.keys(document.paths),
		info: document.info,
		statuses: Object.keys(document.paths["/shop/place-order"].post.responses),
		valid: validation.valid,
		validationErrors: validation.errors ?? [],
		plain: Plain.operations.map((operation: Any) => operation.id),
		manual: Manual.operations.map((operation: Any) => operation.id),
	};
}

const EXPECTED = {
	added: "lamp",
	duplicate: "RepositoryUniqueViolation",
	order: { sku: "lamp", quantity: 2 },
	unknown: "UnknownProduct",
	audited: 2,
	operations: [
		{ id: "Shop.addProduct", tags: ["public", "api"] },
		{ id: "Shop.placeOrder", tags: ["public", "api"] },
	],
	paths: ["/shop/add-product", "/shop/place-order"],
	info: { title: "Shop", version: "1.0.0" },
	statuses: ["200", "400", "404", "500"],
	valid: true,
	validationErrors: [],
	plain: ["Admin.addProduct"],
	manual: ["Shop.addProduct", "Shop.placeOrder"],
};

describe("JSON -> app -> JSON: shop", () => {
	test("the spec is valid with the catalogs", () => {
		expect(validateSpec(shopSpec, {}, SHOP_OPTIONS)).toEqual([]);
		expect(validateSpec(shopSpec).map((issue) => issue.code)).toContain(
			"unknown_provider",
		);
	});

	test("generates clean code, behaves and extracts to the same spec", async () => {
		const project = await buildProject(
			[{ root: ".", spec: shopSpec }],
			SHOP_OPTIONS,
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await behave(App)).toEqual(EXPECTED);

		const extracted = extractSpec(App, {
			outputDir: "src/shop",
			imports: SHOP_IMPORTS,
		});
		expect(validateSpec(extracted, {}, SHOP_OPTIONS)).toEqual([]);
		expect(canonical(extracted)).toEqual(canonical(shopSpec));
	}, 180_000);
});
