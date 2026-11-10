/** The signature schemes the `webhooks` option verifies. */
export const WEBHOOK_SCHEMES = [
	"stripe",
	"github",
	"standard-webhooks",
	"hmac-sha256",
] as const;

export type WebhookScheme = (typeof WEBHOOK_SCHEMES)[number];

/** Schemes whose signature covers a timestamp, so `tolerance` applies. */
export const TIMESTAMPED_SCHEMES: readonly WebhookScheme[] = [
	"stripe",
	"standard-webhooks",
];

/** The verification of one webhook route. JSON, so it can live in an `afora.json`. */
export interface WebhookOptions {
	/**
	 * How the request is signed:
	 * - `"stripe"`: `Stripe-Signature: t=<seconds>,v1=<hex>`, HMAC-SHA256 of `"<t>.<body>"`.
	 * - `"github"`: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the body.
	 * - `"standard-webhooks"`: `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64>`,
	 *   HMAC-SHA256 of `"<id>.<timestamp>.<body>"` with the base64 key after `whsec_`.
	 * - `"hmac-sha256"`: HMAC-SHA256 of the body in `header`, `encoding` after `prefix`.
	 */
	readonly scheme: WebhookScheme;
	/**
	 * The name of the variable holding the secret: a Workers binding or a
	 * process variable. A list allows rotation: the request passes when any
	 * secret that is set verifies it.
	 */
	readonly secret: { readonly env: string | readonly string[] };
	/** `"hmac-sha256"` only, and required there: the header with the signature. */
	readonly header?: string;
	/** `"hmac-sha256"` only: how the signature is written, `"hex"` (default) or `"base64"`. */
	readonly encoding?: "hex" | "base64";
	/** `"hmac-sha256"` only: text before the signature, e.g. `"sha256="`. */
	readonly prefix?: string;
	/**
	 * `"stripe"` and `"standard-webhooks"` only: how many seconds the
	 * timestamp may be away from now, against replays. 300 by default; 0
	 * turns the check off.
	 */
	readonly tolerance?: number;
	/**
	 * `"reject"` (default): a key the input does not declare is a 400, as on
	 * any route. `"strip"`: such keys are dropped first (`stripUndeclared`),
	 * for payloads that carry more than the operation reads.
	 */
	readonly unknownKeys?: "reject" | "strip";
}

/** The headers a scheme reads, as written in the OpenAPI document. */
export function signatureHeadersOf(options: WebhookOptions): readonly string[] {
	switch (options.scheme) {
		case "stripe":
			return ["Stripe-Signature"];
		case "github":
			return ["X-Hub-Signature-256"];
		case "standard-webhooks":
			return ["webhook-id", "webhook-timestamp", "webhook-signature"];
		case "hmac-sha256":
			return [options.header as string];
	}
}

/** Why a request failed verification; never sent to the caller without `debug`. */
export type WebhookFailure =
	| "missing_signature"
	| "malformed_signature"
	| "expired"
	| "mismatch";

const encoder = new TextEncoder();

/** Bytes on an `ArrayBuffer`, as Web Crypto takes them. */
type Bytes = Uint8Array<ArrayBuffer>;

function hexBytes(text: string): Bytes | undefined {
	if (
		text.length === 0 ||
		text.length % 2 !== 0 ||
		!/^[0-9a-fA-F]+$/.test(text)
	) {
		return undefined;
	}
	const bytes = new Uint8Array(text.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function base64Bytes(text: string): Bytes | undefined {
	if (text.length === 0) return undefined;
	try {
		const binary = atob(text);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return undefined;
	}
}

/** The bytes that were signed: `prefix` as UTF-8, then the raw body. */
function signedBytes(prefix: string, body: Uint8Array): Bytes {
	const head = encoder.encode(prefix);
	const bytes = new Uint8Array(head.length + body.length);
	bytes.set(head);
	bytes.set(body, head.length);
	return bytes;
}

/** Whether `signature` is the HMAC-SHA256 of `data` with `key`, compared in constant time. */
async function hmacMatches(
	key: Bytes,
	signature: Bytes,
	data: Bytes,
): Promise<boolean> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", cryptoKey, signature, data);
}

/** What `verifyWebhook` reads of a request. */
export interface WebhookRequest {
	/** A header by name, case-insensitive. */
	header(name: string): string | undefined;
	/** The body, byte for byte as it was received. */
	readonly body: Uint8Array;
	/** Seconds since the epoch; `Date.now() / 1000` by default. */
	readonly now?: number;
}

/** The candidate signatures of a request and the bytes they sign, by scheme. */
function candidatesOf(
	options: WebhookOptions,
	request: WebhookRequest,
	now: number,
):
	| { readonly failure: WebhookFailure }
	| {
			readonly data: Bytes;
			readonly signatures: readonly Bytes[];
	  } {
	const tolerance = options.tolerance ?? 300;
	const stale = (timestamp: number) =>
		tolerance > 0 && Math.abs(now - timestamp) > tolerance;

	switch (options.scheme) {
		case "stripe": {
			const header = request.header("stripe-signature");
			if (!header) return { failure: "missing_signature" };
			let timestamp: string | undefined;
			const signatures: Bytes[] = [];
			for (const part of header.split(",")) {
				const at = part.indexOf("=");
				if (at < 0) continue;
				const key = part.slice(0, at).trim();
				const value = part.slice(at + 1).trim();
				if (key === "t") timestamp = value;
				else if (key === "v1") {
					const bytes = hexBytes(value);
					if (bytes) signatures.push(bytes);
				}
			}
			if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
				return { failure: "malformed_signature" };
			}
			if (stale(Number(timestamp))) return { failure: "expired" };
			return { data: signedBytes(`${timestamp}.`, request.body), signatures };
		}
		case "github": {
			const header = request.header("x-hub-signature-256");
			if (!header) return { failure: "missing_signature" };
			const bytes = header.startsWith("sha256=")
				? hexBytes(header.slice("sha256=".length))
				: undefined;
			if (!bytes) return { failure: "malformed_signature" };
			return { data: new Uint8Array(request.body), signatures: [bytes] };
		}
		case "standard-webhooks": {
			const id = request.header("webhook-id");
			const timestamp = request.header("webhook-timestamp");
			const header = request.header("webhook-signature");
			if (!id || !timestamp || !header) return { failure: "missing_signature" };
			if (!/^\d+$/.test(timestamp)) return { failure: "malformed_signature" };
			const signatures: Bytes[] = [];
			for (const part of header.split(" ")) {
				if (!part.startsWith("v1,")) continue;
				const bytes = base64Bytes(part.slice(3));
				if (bytes) signatures.push(bytes);
			}
			if (signatures.length === 0) return { failure: "malformed_signature" };
			if (stale(Number(timestamp))) return { failure: "expired" };
			return {
				data: signedBytes(`${id}.${timestamp}.`, request.body),
				signatures,
			};
		}
		case "hmac-sha256": {
			const header = request.header(options.header as string);
			if (!header) return { failure: "missing_signature" };
			const prefix = options.prefix ?? "";
			if (!header.startsWith(prefix)) return { failure: "malformed_signature" };
			const text = header.slice(prefix.length).trim();
			const bytes =
				options.encoding === "base64" ? base64Bytes(text) : hexBytes(text);
			if (!bytes) return { failure: "malformed_signature" };
			return { data: new Uint8Array(request.body), signatures: [bytes] };
		}
	}
}

/** The key bytes of a secret: standard-webhooks keys are base64 after `whsec_`. */
function keyOf(scheme: WebhookScheme, secret: string): Bytes | undefined {
	if (scheme !== "standard-webhooks") return encoder.encode(secret);
	return base64Bytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
}

/**
 * Whether `request` is signed by one of `secrets` under `options.scheme`:
 * `undefined` when it is, else why not. Uses Web Crypto only, so it runs on
 * Bun, Node and Workers; signatures are compared by `crypto.subtle.verify`.
 */
export async function verifyWebhook(
	options: WebhookOptions,
	secrets: readonly string[],
	request: WebhookRequest,
): Promise<WebhookFailure | undefined> {
	const now = request.now ?? Math.floor(Date.now() / 1000);
	const candidates = candidatesOf(options, request, now);
	if ("failure" in candidates) return candidates.failure;

	for (const secret of secrets) {
		const key = keyOf(options.scheme, secret);
		if (!key || key.length === 0) continue;
		for (const signature of candidates.signatures) {
			if (await hmacMatches(key, signature, candidates.data)) return undefined;
		}
	}
	return "mismatch";
}
