import { afterAll, describe, expect, test } from "bun:test";
import { extractSpec, validateSpec } from "../../src";
import { variantSpec } from "./fixtures/variant";
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

/** Stores payments with each kind of variant and reads them back. */
async function behave(App: Any) {
	const { Payments, Wallets } = App.repositories;
	const wallet = await Wallets.create({ owner: "Ana" });
	const first = await Payments.create({
		event: { type: "signup", email: " ANA@example.com " },
		method: { method: "card", last4: "4242", holder: "Ana" },
		source: { kind: "wallet", ...wallet.toJSON() },
		history: [
			{ type: "click", target: "buy" },
			{ type: "signup", email: "ana@example.com" },
		],
		attempts: [{ type: "clickedSomewhere", target: "cart" }],
	});
	const second = await Payments.create({
		event: { type: "visit", path: "/home" },
		method: { method: "pix", key: "ana-key" },
		history: [],
	});
	const found = await Payments.findById(first.id);
	const other = await Payments.findById(second.id);
	return {
		first: found.toJSON().event,
		method: found.toJSON().method,
		wallet: found.source.owner,
		walletId: found.source.id === wallet.id,
		history: found.toJSON().history,
		attempts: found.toJSON().attempts,
		second: {
			event: other.toJSON().event,
			method: other.toJSON().method,
			source: other.source,
		},
		invalid: {
			tag: await caught(
				Payments.create({
					event: { type: "scroll" },
					method: { method: "pix", key: "k" },
					history: [],
				}),
			),
			list: await caught(
				Payments.create({
					event: { type: "visit", path: "/" },
					method: { method: "pix", key: "k" },
					history: [1, 2, 3, 4].map(() => ({ type: "click", target: "x" })),
				}),
			),
		},
	};
}

const EXPECTED = {
	first: { type: "signup", email: "ana@example.com" },
	method: { method: "card", last4: "4242", holder: "********" },
	wallet: "Ana",
	walletId: true,
	history: [
		{ type: "click", target: "buy" },
		{ type: "signup", email: "ana@example.com" },
	],
	attempts: [{ type: "clickedSomewhere", target: "cart" }],
	second: {
		event: { type: "visit", path: "/home" },
		method: { method: "pix", key: "ana-key" },
		source: undefined,
	},
	invalid: { tag: "InvalidRecordValue", list: "InvalidRecordValue" },
};

describe("JSON -> app -> JSON: variants", () => {
	test("the spec is valid", () => {
		expect(validateSpec(variantSpec)).toEqual([]);
	});

	test("generates clean code, behaves and extracts to the same spec", async () => {
		const project = await buildProject([{ root: ".", spec: variantSpec }]);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await behave(App)).toEqual(EXPECTED);

		const extracted = extractSpec(App, { outputDir: "src/payments" });
		expect(validateSpec(extracted)).toEqual([]);
		expect(canonical(extracted)).toEqual(canonical(variantSpec));
	}, 180_000);
});
