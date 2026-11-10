import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	blueprintOf,
	commandOf,
	InvalidOutputStage,
	optionalOf,
	outputOf,
	PROBLEM_MEDIA_TYPE,
	useCaseOf,
} from "@afora/core";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import type { Hono } from "hono";
import {
	hono,
	InvalidWebhookSignature,
	type WebhookOptions,
	WebhookSecretMissing,
} from "../src/index";
import { verifyWebhook } from "../src/webhook";

const SECRET = "whsec_test_secret";
// A standard-webhooks secret: "whsec_" + base64 of the key bytes.
const STANDARD_SECRET = `whsec_${btoa("standard-webhooks-key-bytes")}`;

class Received extends useCaseOf({
	name: "Received",
	blueprint: blueprintOf((ctx) => ({
		type: ctx.string,
		data: blueprintOf(() => ({
			object: blueprintOf((leaf) => ({ id: ctx.string, amount: leaf.integer })),
		})),
	})),
	response: blueprintOf((ctx) => ({
		type: ctx.string,
		id: ctx.string,
		amount: ctx.integer,
		delivery: optionalOf(ctx.string),
	})),
	context: blueprintOf((ctx) => ({ delivery: optionalOf(ctx.string) })),
}) {
	override async execute() {
		const { type, data } = this.input;
		return {
			type,
			id: data.object.id,
			amount: data.object.amount,
			delivery: this.context.delivery,
		};
	}
}

class Lookup extends useCaseOf({
	name: "Lookup",
	blueprint: blueprintOf((ctx) => ({ id: optionalOf(ctx.string) })),
	response: blueprintOf((ctx) => ({ found: ctx.boolean })),
}) {
	override async execute() {
		return { found: true };
	}
}

const Payments = commandOf({
	name: "Payments",
	useCases: { received: Received, lookup: Lookup },
});

function api(
	webhook: WebhookOptions,
	extra: Partial<Parameters<typeof hono>[0]> = {},
): Hono {
	return outputOf({
		name: "Billing",
		commands: [Payments],
		pipe: [
			hono({
				webhooks: { "Payments.received": webhook },
				context: { headers: { delivery: "webhook-id" } },
				docs: {
					path: "/openapi.json",
					info: { title: "Billing", version: "1.0.0" },
				},
				...extra,
			}),
		],
	}).build() as Hono;
}

const event = {
	type: "payment_intent.succeeded",
	data: { object: { id: "pi_1", amount: 1200 } },
};
// What Stripe sends: much more than the operation reads.
const stripeEvent = {
	id: "evt_1",
	object: "event",
	livemode: false,
	type: "payment_intent.succeeded",
	data: { object: { id: "pi_1", amount: 1200, currency: "brl", metadata: {} } },
};

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new Uint8Array(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(
		await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)),
	);
}

const hex = (bytes: Uint8Array) =>
	[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const now = () => Math.floor(Date.now() / 1000);

async function stripeHeaders(body: string, secret = SECRET, t = now()) {
	const signature = hex(await hmac(encoder.encode(secret), `${t}.${body}`));
	return { "stripe-signature": `t=${t},v1=${signature}` };
}

async function githubHeaders(body: string, secret = SECRET) {
	return {
		"x-hub-signature-256": `sha256=${hex(await hmac(encoder.encode(secret), body))}`,
	};
}

async function standardHeaders(
	body: string,
	secret = STANDARD_SECRET,
	t = now(),
	id = "msg_1",
) {
	const key = Uint8Array.from(atob(secret.slice(6)), (char) =>
		char.charCodeAt(0),
	);
	const signature = base64(await hmac(key, `${id}.${t}.${body}`));
	return {
		"webhook-id": id,
		"webhook-timestamp": String(t),
		"webhook-signature": `v1,${signature}`,
	};
}

const send = (app: Hono, body: string, headers: Record<string, string>) =>
	app.request("/payments/received", {
		method: "POST",
		body,
		headers: { "content-type": "application/json", ...headers },
	});

const saved = { ...process.env };
beforeEach(() => {
	process.env.WEBHOOK_SECRET = SECRET;
	process.env.STANDARD_SECRET = STANDARD_SECRET;
});
afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	Object.assign(process.env, saved);
});

describe("hono webhooks", () => {
	describe("stripe", () => {
		const options: WebhookOptions = {
			scheme: "stripe",
			secret: { env: "WEBHOOK_SECRET" },
		};

		test("accepts a signed request", async () => {
			const body = JSON.stringify(event);
			const response = await send(
				api(options),
				body,
				await stripeHeaders(body),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				type: "payment_intent.succeeded",
				id: "pi_1",
				amount: 1200,
			});
		});

		test("accepts any of several v1 signatures", async () => {
			const body = JSON.stringify(event);
			const t = now();
			const good = hex(await hmac(encoder.encode(SECRET), `${t}.${body}`));
			const response = await send(api(options), body, {
				"stripe-signature": `t=${t},v1=${"0".repeat(64)},v1=${good}`,
			});
			expect(response.status).toBe(200);
		});

		test("rejects a tampered body, a wrong secret and a missing header with 401", async () => {
			const app = api(options);
			const body = JSON.stringify(event);
			const headers = await stripeHeaders(body);

			const tampered = await send(app, body.replace("1200", "9999"), headers);
			expect(tampered.status).toBe(401);
			expect(tampered.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
			const problem = (await tampered.json()) as Record<string, unknown>;
			expect(problem).toMatchObject({
				title: "InvalidWebhookSignature",
				status: 401,
				detail: "The webhook signature is missing, invalid or expired.",
				layer: "output",
			});
			expect(problem.trace).toBeUndefined();

			const wrong = await send(
				app,
				body,
				await stripeHeaders(body, "whsec_other"),
			);
			expect(wrong.status).toBe(401);
			expect((await send(app, body, {})).status).toBe(401);
			expect(
				(await send(app, body, { "stripe-signature": "garbage" })).status,
			).toBe(401);
		});

		test("rejects an old timestamp, unless tolerance is 0", async () => {
			const body = JSON.stringify(event);
			const old = await stripeHeaders(body, SECRET, now() - 301);
			expect((await send(api(options), body, old)).status).toBe(401);
			expect(
				(await send(api({ ...options, tolerance: 600 }), body, old)).status,
			).toBe(200);
			const ancient = await stripeHeaders(body, SECRET, now() - 86_400);
			expect(
				(await send(api({ ...options, tolerance: 0 }), body, ancient)).status,
			).toBe(200);
		});

		test("says why in the trace with debug", async () => {
			const body = JSON.stringify(event);
			const old = await stripeHeaders(body, SECRET, now() - 1000);
			const response = await send(api(options, { debug: true }), body, old);
			const problem = (await response.json()) as { trace: string };
			expect(problem.trace).toContain("expired");
		});
	});

	test("github", async () => {
		const app = api({ scheme: "github", secret: { env: "WEBHOOK_SECRET" } });
		const body = JSON.stringify(event);
		expect((await send(app, body, await githubHeaders(body))).status).toBe(200);
		expect(
			(await send(app, body, await githubHeaders(body, "nope"))).status,
		).toBe(401);
		expect(
			(await send(app, body, { "x-hub-signature-256": "sha1=abc" })).status,
		).toBe(401);
	});

	describe("standard-webhooks", () => {
		const options: WebhookOptions = {
			scheme: "standard-webhooks",
			secret: { env: "STANDARD_SECRET" },
		};

		test("accepts a signed request and maps webhook-id into the context", async () => {
			const body = JSON.stringify(event);
			const response = await send(
				api(options),
				body,
				await standardHeaders(body),
			);
			expect(response.status).toBe(200);
			expect(((await response.json()) as { delivery: string }).delivery).toBe(
				"msg_1",
			);
		});

		test("rejects a signature for another id, an old timestamp and a wrong key", async () => {
			const app = api(options);
			const body = JSON.stringify(event);
			const headers = await standardHeaders(body);
			expect(
				(await send(app, body, { ...headers, "webhook-id": "msg_2" })).status,
			).toBe(401);
			expect(
				(
					await send(
						app,
						body,
						await standardHeaders(body, STANDARD_SECRET, now() - 400),
					)
				).status,
			).toBe(401);
			expect(
				(
					await send(
						app,
						body,
						await standardHeaders(body, `whsec_${btoa("another-key")}`),
					)
				).status,
			).toBe(401);
		});
	});

	describe("hmac-sha256", () => {
		test("hex with a prefix", async () => {
			const app = api({
				scheme: "hmac-sha256",
				secret: { env: "WEBHOOK_SECRET" },
				header: "x-signature",
				prefix: "sha256=",
			});
			const body = JSON.stringify(event);
			const signature = hex(await hmac(encoder.encode(SECRET), body));
			expect(
				(await send(app, body, { "x-signature": `sha256=${signature}` }))
					.status,
			).toBe(200);
			expect((await send(app, body, { "x-signature": signature })).status).toBe(
				401,
			);
		});

		test("base64", async () => {
			const app = api({
				scheme: "hmac-sha256",
				secret: { env: "WEBHOOK_SECRET" },
				header: "x-signature",
				encoding: "base64",
			});
			const body = JSON.stringify(event);
			const signature = base64(await hmac(encoder.encode(SECRET), body));
			expect((await send(app, body, { "x-signature": signature })).status).toBe(
				200,
			);
		});
	});

	test("verifies the bytes as sent: a BOM and non-ASCII text", async () => {
		const app = api({ scheme: "github", secret: { env: "WEBHOOK_SECRET" } });
		const body = JSON.stringify({ ...event, type: "pagamento.concluído ✓" });
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(body)]);
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = hex(
			new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)),
		);
		const response = await app.request("/payments/received", {
			method: "POST",
			body: bytes,
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": `sha256=${signature}`,
			},
		});
		// The signature passes; the BOM is then dropped by the decoder.
		expect(response.status).toBe(200);
		expect(((await response.json()) as { type: string }).type).toBe(
			"pagamento.concluído ✓",
		);
	});

	test("rotation: any secret that is set verifies", async () => {
		process.env.OLD_SECRET = "whsec_old";
		const options: WebhookOptions = {
			scheme: "stripe",
			secret: { env: ["UNSET_SECRET", "WEBHOOK_SECRET", "OLD_SECRET"] },
		};
		const body = JSON.stringify(event);
		expect(
			(await send(api(options), body, await stripeHeaders(body, "whsec_old")))
				.status,
		).toBe(200);
		expect(
			(await send(api(options), body, await stripeHeaders(body, SECRET)))
				.status,
		).toBe(200);
	});

	test("reads the secret from the bindings of the request first", async () => {
		const app = api({ scheme: "github", secret: { env: "BOUND_SECRET" } });
		const body = JSON.stringify(event);
		const response = await app.request(
			"/payments/received",
			{
				method: "POST",
				body,
				headers: await githubHeaders(body, "from-binding"),
			},
			{ BOUND_SECRET: "from-binding" },
		);
		expect(response.status).toBe(200);
	});

	test("a missing secret is a 500 that does not name it", async () => {
		const app = api({ scheme: "github", secret: { env: "NOT_SET" } });
		const body = JSON.stringify(event);
		const response = await send(app, body, await githubHeaders(body));
		expect(response.status).toBe(500);
		const problem = (await response.json()) as Record<string, unknown>;
		expect(problem.title).toBe("WebhookSecretMissing");
		expect(problem.detail).toBe("Internal error.");
	});

	describe("unknownKeys", () => {
		test("rejects undeclared keys by default", async () => {
			const app = api({ scheme: "github", secret: { env: "WEBHOOK_SECRET" } });
			const body = JSON.stringify(stripeEvent);
			const response = await send(app, body, await githubHeaders(body));
			expect(response.status).toBe(400);
			const { issues } = (await response.json()) as {
				issues: { code: string; path: unknown[] }[];
			};
			expect(issues.map((issue) => issue.code)).toContain("undeclared_key");
		});

		test('"strip" drops them before parsing', async () => {
			const app = api({
				scheme: "github",
				secret: { env: "WEBHOOK_SECRET" },
				unknownKeys: "strip",
			});
			const body = JSON.stringify(stripeEvent);
			const response = await send(app, body, await githubHeaders(body));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				type: "payment_intent.succeeded",
				id: "pi_1",
				amount: 1200,
			});
		});
	});

	test("invalid JSON after a valid signature is a 400", async () => {
		const app = api({ scheme: "github", secret: { env: "WEBHOOK_SECRET" } });
		const response = await send(app, "{nope", await githubHeaders("{nope"));
		expect(response.status).toBe(400);
		expect(((await response.json()) as { title: string }).title).toBe(
			"InvalidRequestBody",
		);
	});

	test("other routes are not verified", async () => {
		const app = api({ scheme: "github", secret: { env: "WEBHOOK_SECRET" } });
		const response = await app.request("/payments/lookup", {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(200);
	});

	test("output statuses can change the status of a bad signature", async () => {
		const app = outputOf({
			name: "Billing",
			commands: [Payments],
			statuses: { InvalidWebhookSignature: 403 },
			pipe: [
				hono({
					webhooks: {
						"Payments.received": {
							scheme: "github",
							secret: { env: "WEBHOOK_SECRET" },
						},
					},
				}),
			],
		}).build() as Hono;
		expect((await send(app, "{}", {})).status).toBe(403);
	});

	test("documents the signature headers and the 401, never the secret", async () => {
		const app = api({
			scheme: "standard-webhooks",
			secret: { env: "STANDARD_SECRET" },
		});
		const document = (await (await app.request("/openapi.json")).json()) as {
			paths: Record<string, Record<string, Record<string, unknown>>>;
		};
		const operation = document.paths["/payments/received"]?.post as {
			parameters: { name: string; in: string; required: boolean }[];
			responses: Record<string, unknown>;
			"x-afora-webhook": unknown;
		};
		expect(operation.parameters.map((parameter) => parameter.name)).toEqual([
			"webhook-id",
			"webhook-timestamp",
			"webhook-signature",
		]);
		expect(operation.parameters.every((parameter) => parameter.required)).toBe(
			true,
		);
		expect(Object.keys(operation.responses)).toEqual([
			"200",
			"400",
			"401",
			"500",
		]);
		expect(operation["x-afora-webhook"]).toEqual({
			scheme: "standard-webhooks",
		});
		expect(
			document.paths["/payments/lookup"]?.post?.["x-afora-webhook"],
		).toBeUndefined();
		expect(JSON.stringify(document)).not.toContain("STANDARD_SECRET");

		const result = await new Validator().validate(
			document as unknown as SpecData,
		);
		expect(result.valid).toBe(true);
	});

	describe("options", () => {
		const invalid = (webhooks: unknown) => () =>
			hono({ webhooks } as Parameters<typeof hono>[0]);

		test("are validated when the stage is made", () => {
			for (const [webhooks, message] of [
				[[], "Expected hono.webhooks to be an object."],
				[
					{ a: { scheme: "md5", secret: { env: "S" } } },
					'hono.webhooks["a"].scheme',
				],
				[{ a: { scheme: "github" } }, 'hono.webhooks["a"].secret'],
				[
					{ a: { scheme: "github", secret: { env: [] } } },
					'hono.webhooks["a"].secret',
				],
				[
					{ a: { scheme: "github", secret: { env: "" } } },
					'hono.webhooks["a"].secret',
				],
				[
					{ a: { scheme: "github", secret: { env: "S" }, header: "x" } },
					'hono.webhooks["a"].header is only for the "hmac-sha256" scheme.',
				],
				[
					{ a: { scheme: "hmac-sha256", secret: { env: "S" } } },
					'Expected hono.webhooks["a"].header to be a header name.',
				],
				[
					{
						a: {
							scheme: "hmac-sha256",
							secret: { env: "S" },
							header: "x",
							encoding: "hex2",
						},
					},
					'hono.webhooks["a"].encoding',
				],
				[
					{ a: { scheme: "github", secret: { env: "S" }, tolerance: 10 } },
					'hono.webhooks["a"].tolerance is only for',
				],
				[
					{ a: { scheme: "stripe", secret: { env: "S" }, tolerance: -1 } },
					'hono.webhooks["a"].tolerance to be a whole number',
				],
				[
					{
						a: { scheme: "stripe", secret: { env: "S" }, unknownKeys: "keep" },
					},
					'hono.webhooks["a"].unknownKeys',
				],
				[
					{ a: { scheme: "stripe", secret: { env: "S" }, other: 1 } },
					'hono.webhooks["a"] has no option "other".',
				],
			] as const) {
				expect(invalid(webhooks)).toThrow(message);
			}
			expect(invalid({ a: { scheme: "md5", secret: { env: "S" } } })).toThrow(
				InvalidOutputStage,
			);
		});

		test("name operations served by a body method, when the app is built", () => {
			const build =
				(webhooks: Record<string, WebhookOptions>, route = {}) =>
				() =>
					outputOf({
						name: "Billing",
						commands: [Payments],
						pipe: [hono({ webhooks, route })],
					}).build();
			const github: WebhookOptions = { scheme: "github", secret: { env: "S" } };
			expect(build({ "Payments.nope": github })).toThrow(
				'hono.webhooks["Payments.nope"] names no operation of the output.',
			);
			expect(
				build(
					{ "Payments.lookup": github },
					{ "Payments.lookup": { method: "get" } },
				),
			).toThrow('is routed with "get", which has no body to sign');
		});
	});

	test("the exceptions are exported", () => {
		expect(
			new InvalidWebhookSignature({
				source: "t",
				details: { scheme: "github", reason: "mismatch" },
			}).message,
		).toBe("The webhook signature is missing, invalid or expired.");
		expect(
			new WebhookSecretMissing({
				source: "t",
				details: { variables: ["A", "B"] },
			}).message,
		).toBe("No webhook secret is set (A, B).");
	});
});

describe("verifyWebhook", () => {
	const body = encoder.encode('{"a":1}');
	const header = (headers: Record<string, string>) => (name: string) =>
		headers[name.toLowerCase()];

	test("tells why a request fails", async () => {
		const github: WebhookOptions = { scheme: "github", secret: { env: "S" } };
		expect(
			await verifyWebhook(github, ["k"], { header: header({}), body }),
		).toBe("missing_signature");
		expect(
			await verifyWebhook(github, ["k"], {
				header: header({ "x-hub-signature-256": "sha256=zz" }),
				body,
			}),
		).toBe("malformed_signature");
		expect(
			await verifyWebhook(github, ["k"], {
				header: header({ "x-hub-signature-256": `sha256=${"ab".repeat(32)}` }),
				body,
			}),
		).toBe("mismatch");

		const stripe: WebhookOptions = { scheme: "stripe", secret: { env: "S" } };
		expect(
			await verifyWebhook(stripe, ["k"], {
				header: header({ "stripe-signature": `t=100,v1=${"ab".repeat(32)}` }),
				body,
				now: 1000,
			}),
		).toBe("expired");
	});

	test("skips a standard-webhooks secret that is not base64", async () => {
		const options: WebhookOptions = {
			scheme: "standard-webhooks",
			secret: { env: "S" },
		};
		const t = now();
		const headers = await standardHeaders('{"a":1}', STANDARD_SECRET, t);
		expect(
			await verifyWebhook(options, ["whsec_%%%", STANDARD_SECRET], {
				header: header(headers),
				body,
			}),
		).toBeUndefined();
	});
});
