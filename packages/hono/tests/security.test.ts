import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	commandOf,
	InvalidOutputStage,
	outputOf,
	useCaseOf,
} from "@afora/core";
import type { Hono } from "hono";
import { hono } from "../src/index";

const SECRET = "whsec_test_secret";
const encoder = new TextEncoder();

async function hmacHex(key: string, data: string): Promise<string> {
	const k = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", k, encoder.encode(data));
	return [...new Uint8Array(signature)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type Route = Parameters<typeof useCaseOf>[0]["route"];

function webhookApp(route: Route): Hono {
	class Paid extends useCaseOf({
		name: "Paid",
		blueprint: blueprintOf((ctx) => ({
			tenant: ctx.string,
			amount: ctx.integer,
		})),
		response: blueprintOf((ctx) => ({
			tenant: ctx.string,
			amount: ctx.integer,
		})),
		...(route ? { route } : {}),
	}) {
		override async execute() {
			return this.input;
		}
	}
	const Billing = commandOf({ name: "Billing", useCases: { paid: Paid } });
	return outputOf({
		name: "Api",
		commands: [Billing],
		pipe: [
			hono({
				webhooks: {
					"Billing.paid": {
						scheme: "stripe",
						secret: { env: "STRIPE_WEBHOOK_SECRET" },
					},
				},
			}),
		],
	}).build() as Hono;
}

describe("SEC-37: every input key of a webhook comes from the signed body", () => {
	test("SEC-37: a webhook route with a path parameter throws at build", () => {
		expect(() =>
			webhookApp({ method: "post", path: "/tenants/{tenant}/paid" }),
		).toThrow(InvalidOutputStage);
	});

	test("SEC-37: a webhook route with query keys throws at build", () => {
		expect(() =>
			webhookApp({ method: "post", path: "/paid", query: ["tenant"] }),
		).toThrow(InvalidOutputStage);
	});

	test("SEC-37: a webhook route with header keys throws at build", () => {
		expect(() =>
			webhookApp({
				method: "post",
				path: "/paid",
				headers: { tenant: "x-tenant" },
			}),
		).toThrow(InvalidOutputStage);
	});

	test("SEC-37: a webhook route with cookie keys throws at build", () => {
		expect(() =>
			webhookApp({
				method: "post",
				path: "/paid",
				cookie: { tenant: "tenant" },
			}),
		).toThrow(InvalidOutputStage);
	});

	test("SEC-37: a webhook with body-only inputs still verifies and runs", async () => {
		const app = webhookApp({ method: "post", path: "/paid" });
		const env = { STRIPE_WEBHOOK_SECRET: SECRET };
		const body = JSON.stringify({ tenant: "acme", amount: 1200 });
		const t = Math.floor(Date.now() / 1000);
		const signature = `t=${t},v1=${await hmacHex(SECRET, `${t}.${body}`)}`;
		const send = (signed: string) =>
			app.request(
				"/paid",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"stripe-signature": signed,
					},
					body,
				},
				env,
			);
		const ok = await send(signature);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ tenant: "acme", amount: 1200 });
		const refused = await send(`t=${t},v1=${"0".repeat(64)}`);
		expect(refused.status).toBe(401);
	});
});
