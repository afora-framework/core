/**
 * The invariants afora claims, checked on a running API through the HTTP
 * contract of BRIEF.md. The same probes run against every implementation:
 * an afora run (the generated Hono app) or a hand-rolled baseline. They only
 * need a fetch-like handler, so nothing listens on a port.
 *
 * A run is checked against the version of the brief it was built from:
 * version 1 (BRIEF.v1.md) has no sessions nor owners, version 2 (BRIEF.md)
 * adds a token and events only their organizer reads or changes.
 */

/** A fetch-like handler: `app.fetch` of a Hono app, or anything with that shape. */
export type Handler = (request: Request) => Response | Promise<Response>;

export const INVARIANTS = {
	sensitive: "No sensitive value in any response",
	undeclared: "Undeclared keys rejected (4xx)",
	problems: "Errors are problem+json with the right status, never 5xx",
	unique: "Unique keys enforced (409)",
	ownership: "Only its organizer reads or changes an event (401, 403/404)",
} as const;
export type Invariant = keyof typeof INVARIANTS;
export const INVARIANT_IDS = Object.keys(INVARIANTS) as Invariant[];

/** The versions of the brief: BRIEF.v1.md and BRIEF.md. */
export type BriefVersion = 1 | 2;
export const CURRENT_BRIEF: BriefVersion = 2;

/** The invariants a run of this version of the brief is checked for. */
export function invariantsOf(brief: BriefVersion): Invariant[] {
	return brief === 1
		? INVARIANT_IDS.filter((id) => id !== "ownership")
		: INVARIANT_IDS;
}

/**
 * The JWT secret an implementation of brief 2 is started with (the brief has
 * it read from JWT_SECRET). The evaluation sets the variable before it loads
 * an implementation.
 */
export const EVAL_JWT_SECRET = "agent-built-evaluation-secret-0123456789";

export interface Check {
	readonly invariant: Invariant;
	readonly name: string;
	readonly ok: boolean;
	/** Why it failed: what was expected and what came back. */
	readonly detail?: string;
}

export interface Evaluation {
	readonly brief: BriefVersion;
	readonly checks: readonly Check[];
	/** Whether every check of each invariant of the brief passed. */
	readonly passed: Readonly<Partial<Record<Invariant, boolean>>>;
}

interface Exchange {
	readonly label: string;
	readonly status: number;
	readonly contentType: string;
	readonly text: string;
	// biome-ignore lint/suspicious/noExplicitAny: a JSON body of any shape
	readonly json: any;
}

const BASE = "http://agent-built.test";
const MASK = "********";
const PASSWORD = "Tick3t!pass";
const OTHER_PASSWORD = "0ther#Secret";
const WRONG_PASSWORD = "Wr0ng!guess";
const SENT_PASSWORDS = [PASSWORD, OTHER_PASSWORD, WRONG_PASSWORD];
/** Password hashes in the usual encodings: argon2, bcrypt, scrypt, PBKDF2. */
const HASH = /\$argon2(id|i|d)\$|\$2[abxy]\$\d\d\$|\$scrypt\$|pbkdf2/i;
/** Keys that hold a secret, whatever an implementation calls them. */
const SECRET_KEY = /pass(word)?|hash|secret|salt/i;

/** Another id of the same shape: the last hexadecimal digit changed. */
function otherId(id: string): string {
	const last = id.at(-1) ?? "0";
	const next = last === "0" ? "1" : "0";
	return `${id.slice(0, -1)}${next}`;
}

/** An HS256 JSON Web Token for `subject`, signed with `secret`. */
async function signJwt(subject: string, secret: string): Promise<string> {
	const encode = (value: string | Uint8Array) =>
		Buffer.from(value).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = encode(
		JSON.stringify({ sub: subject, iat: now, exp: now + 900 }),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${encode(new Uint8Array(signature))}`;
}

/** The id of the organizer of an event: an id, or the nested organizer. */
// biome-ignore lint/suspicious/noExplicitAny: a JSON body of any shape
function organizerOf(event: any): unknown {
	const organizer = event?.organizer ?? event?.organizerId;
	return typeof organizer === "object" && organizer !== null
		? organizer.id
		: organizer;
}

/** Runs the scenario of the brief on `handler` and checks each invariant. */
export async function evaluate(
	handler: Handler,
	brief: BriefVersion = CURRENT_BRIEF,
): Promise<Evaluation> {
	const v2 = brief === 2;
	const exchanges: Exchange[] = [];
	const checks: Check[] = [];
	const check = (
		invariant: Invariant,
		name: string,
		ok: boolean,
		detail?: string,
	) => {
		checks.push({ invariant, name, ok, ...(ok ? {} : { detail }) });
	};

	/** The token requests are sent with, when the brief has one. */
	let token: string | undefined;

	async function send(
		label: string,
		method: string,
		path: string,
		body?: unknown,
		raw?: string,
		as: string | null | undefined = token,
	): Promise<Exchange> {
		const init: RequestInit = { method };
		const headers: Record<string, string> = {};
		if (body !== undefined || raw !== undefined) {
			headers["content-type"] = "application/json";
			init.body = raw ?? JSON.stringify(body);
		}
		if (v2 && as) headers.authorization = `Bearer ${as}`;
		init.headers = headers;
		let exchange: Exchange;
		try {
			const response = await handler(new Request(`${BASE}${path}`, init));
			const text = await response.text();
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {}
			exchange = {
				label,
				status: response.status,
				contentType: response.headers.get("content-type") ?? "",
				text,
				json,
			};
		} catch (error) {
			// a handler that throws is what a server turns into a 500
			exchange = {
				label,
				status: 500,
				contentType: "",
				text: `threw: ${error instanceof Error ? error.message : String(error)}`,
				json: undefined,
			};
		}
		exchanges.push(exchange);
		return exchange;
	}

	const describe = (exchange: Exchange) =>
		`${exchange.status} ${exchange.contentType || "(no content-type)"} ${exchange.text.slice(0, 160)}`;
	const success = (exchange: Exchange) =>
		exchange.status >= 200 && exchange.status < 300;

	/** A problem+json with this status, whose body says the same status. */
	const isProblem = (exchange: Exchange, status: number) =>
		exchange.status === status &&
		exchange.contentType.includes("application/problem+json") &&
		typeof exchange.json === "object" &&
		exchange.json !== null &&
		exchange.json.status === status &&
		typeof exchange.json.title === "string";

	const expectProblem = (
		invariant: Invariant,
		name: string,
		exchange: Exchange,
		status: number,
	) =>
		check(
			invariant,
			name,
			isProblem(exchange, status),
			`expected a ${status} problem+json, got ${describe(exchange)}`,
		);

	// --- the happy path the other probes build on ---
	const ana = { name: "Ana", email: "ana@example.com", password: PASSWORD };
	const registered = await send("register", "POST", "/api/organizers", ana);
	const organizerId: string | undefined = registered.json?.organizer?.id;
	check(
		"problems",
		"setup: register an organizer",
		success(registered) && typeof organizerId === "string",
		`expected 2xx { organizer: { id } }, got ${describe(registered)}`,
	);
	const login = await send("login", "POST", "/api/sessions", {
		email: ana.email,
		password: PASSWORD,
	});
	check(
		"problems",
		v2 ? "setup: log in, which gives a token" : "setup: log in",
		success(login) && (!v2 || typeof login.json?.token === "string"),
		`expected 2xx${v2 ? " { token }" : ""}, got ${describe(login)}`,
	);
	if (v2) token = login.json?.token;

	const party = {
		...(v2 ? {} : { organizerId }),
		title: "Launch party",
		slug: "launch-party",
		capacity: 2,
	};
	const created = await send("create event", "POST", "/api/events", party);
	const eventId: string | undefined = created.json?.event?.id;
	check(
		"problems",
		"setup: create an event",
		success(created) && typeof eventId === "string",
		`expected 2xx { event: { id } }, got ${describe(created)}`,
	);
	const fetched = await send("get event", "GET", `/api/events/${eventId}`);
	check(
		"problems",
		"setup: get the event",
		success(fetched),
		`expected 2xx, got ${describe(fetched)}`,
	);
	for (const buyer of ["bea@example.com", "caio@example.com"]) {
		const bought = await send(
			"buy ticket",
			"POST",
			`/api/events/${eventId}/tickets`,
			{ buyerEmail: buyer },
		);
		check(
			"problems",
			`setup: buy a ticket for ${buyer}`,
			success(bought),
			`expected 2xx, got ${describe(bought)}`,
		);
	}

	// --- unique keys ---
	const duplicateEmail = await send(
		"duplicate email",
		"POST",
		"/api/organizers",
		{
			...ana,
			name: "Another Ana",
			password: OTHER_PASSWORD,
		},
	);
	expectProblem("unique", "a taken email is a 409", duplicateEmail, 409);
	const duplicateSlug = await send("duplicate slug", "POST", "/api/events", {
		...party,
		title: "Same slug",
	});
	expectProblem("unique", "a taken slug is a 409", duplicateSlug, 409);

	// --- business errors ---
	expectProblem(
		"problems",
		"a taken email is a 409 problem",
		duplicateEmail,
		409,
	);
	expectProblem(
		"problems",
		"a taken slug is a 409 problem",
		duplicateSlug,
		409,
	);
	expectProblem(
		"problems",
		"a wrong password is a 401 problem",
		await send("wrong password", "POST", "/api/sessions", {
			email: ana.email,
			password: WRONG_PASSWORD,
		}),
		401,
	);
	expectProblem(
		"problems",
		"an unknown email is a 401 problem",
		await send("unknown email", "POST", "/api/sessions", {
			email: "nobody@example.com",
			password: PASSWORD,
		}),
		401,
	);
	if (!v2) {
		const missingOrganizer = organizerId ? otherId(organizerId) : "unknown";
		expectProblem(
			"problems",
			"an event of an unknown organizer is a 404 problem",
			await send("unknown organizer", "POST", "/api/events", {
				...party,
				organizerId: missingOrganizer,
				slug: "orphan-event",
			}),
			404,
		);
	}
	const missingEvent = eventId ? otherId(eventId) : "unknown";
	expectProblem(
		"problems",
		"an unknown event is a 404 problem",
		await send("unknown event", "GET", `/api/events/${missingEvent}`),
		404,
	);
	expectProblem(
		"problems",
		"a ticket for an unknown event is a 404 problem",
		await send(
			"ticket of unknown event",
			"POST",
			`/api/events/${missingEvent}/tickets`,
			{ buyerEmail: "dan@example.com" },
		),
		404,
	);
	expectProblem(
		"problems",
		"a ticket past the capacity is a 422 problem",
		await send("sold out", "POST", `/api/events/${eventId}/tickets`, {
			buyerEmail: "dan@example.com",
		}),
		422,
	);
	const after = await send("get event again", "GET", `/api/events/${eventId}`);
	check(
		"problems",
		"the event is still readable after the sold-out error",
		success(after),
		`expected 2xx, got ${describe(after)}`,
	);

	// --- invalid input: a 400 problem, never a 5xx ---
	expectProblem(
		"problems",
		"a weak password is a 400 problem",
		await send("weak password", "POST", "/api/organizers", {
			name: "Weak",
			email: "weak@example.com",
			password: "password",
		}),
		400,
	);
	expectProblem(
		"problems",
		"a capacity of 0 is a 400 problem",
		await send("capacity 0", "POST", "/api/events", {
			...party,
			slug: "no-seats",
			capacity: 0,
		}),
		400,
	);
	expectProblem(
		"problems",
		"a body that is not JSON is a 400 problem",
		await send("not json", "POST", "/api/organizers", undefined, "{not json"),
		400,
	);
	expectProblem(
		"problems",
		"a missing field is a 400 problem",
		await send("missing field", "POST", "/api/events", {
			...(v2 ? {} : { organizerId }),
			title: "No slug",
			capacity: 3,
		}),
		400,
	);

	// --- changing an event (brief 2) ---
	let title = party.title;
	if (v2) {
		const renamed = await send(
			"rename event",
			"PATCH",
			`/api/events/${eventId}`,
			{
				title: "Launch night",
			},
		);
		check(
			"problems",
			"setup: the organizer renames the event",
			success(renamed) && renamed.json?.event?.title === "Launch night",
			`expected 2xx { event: { title: "Launch night" } }, got ${describe(renamed)}`,
		);
		if (success(renamed)) title = "Launch night";
		expectProblem(
			"problems",
			"a capacity of 0 in a change is a 400 problem",
			await send("change capacity 0", "PATCH", `/api/events/${eventId}`, {
				capacity: 0,
			}),
			400,
		);
	}

	// --- undeclared keys ---
	const rejected = (exchange: Exchange) =>
		exchange.status >= 400 && exchange.status < 500;
	const undeclared: [string, string, string, unknown][] = [
		[
			"register with role",
			"POST",
			"/api/organizers",
			{
				name: "Eve",
				email: "eve@example.com",
				password: PASSWORD,
				role: "admin",
			},
		],
		[
			"login with remember",
			"POST",
			"/api/sessions",
			{ email: ana.email, password: PASSWORD, remember: true },
		],
		[
			"event with price",
			"POST",
			"/api/events",
			{ ...party, slug: "priced-event", capacity: 10, price: 0 },
		],
		[
			"ticket with seat",
			"POST",
			`/api/events/${eventId}/tickets`,
			{ buyerEmail: "fay@example.com", seat: 1 },
		],
		...(v2
			? ([
					[
						"change with price",
						"PATCH",
						`/api/events/${eventId}`,
						{ title: "Priced", price: 0 },
					],
				] as [string, string, string, unknown][])
			: []),
	];
	for (const [label, method, path, body] of undeclared) {
		const exchange = await send(label, method, path, body);
		check(
			"undeclared",
			`${label}: the extra key is rejected`,
			rejected(exchange),
			`expected a 4xx, got ${describe(exchange)}`,
		);
	}

	// --- ownership (brief 2): who may read or change an event ---
	if (v2) {
		const notYours = (exchange: Exchange) =>
			isProblem(exchange, 404) || isProblem(exchange, 403);
		const expectNotYours = (name: string, exchange: Exchange) =>
			check(
				"ownership",
				name,
				notYours(exchange),
				`expected a 404 or 403 problem+json, got ${describe(exchange)}`,
			);

		expectProblem(
			"ownership",
			"creating an event without a token is a 401 problem",
			await send(
				"create without token",
				"POST",
				"/api/events",
				{ ...party, slug: "anonymous-event" },
				undefined,
				null,
			),
			401,
		);
		expectProblem(
			"ownership",
			"reading an event without a token is a 401 problem",
			await send(
				"get without token",
				"GET",
				`/api/events/${eventId}`,
				undefined,
				undefined,
				null,
			),
			401,
		);
		expectProblem(
			"ownership",
			"changing an event without a token is a 401 problem",
			await send(
				"change without token",
				"PATCH",
				`/api/events/${eventId}`,
				{ title: "Anonymous" },
				undefined,
				null,
			),
			401,
		);
		expectProblem(
			"ownership",
			"a malformed token is a 401 problem",
			await send(
				"garbage token",
				"GET",
				`/api/events/${eventId}`,
				undefined,
				undefined,
				"not-a-token",
			),
			401,
		);
		expectProblem(
			"ownership",
			"a token signed with another secret is a 401 problem",
			await send(
				"forged token",
				"GET",
				`/api/events/${eventId}`,
				undefined,
				undefined,
				await signJwt(
					String(organizerId),
					"not-the-secret-of-the-server-0123456789",
				),
			),
			401,
		);

		const bo = {
			name: "Bo",
			email: "bo@example.com",
			password: OTHER_PASSWORD,
		};
		const boRegistered = await send(
			"register another organizer",
			"POST",
			"/api/organizers",
			bo,
			undefined,
			null,
		);
		const boId: string | undefined = boRegistered.json?.organizer?.id;
		const boLogin = await send(
			"log in as another organizer",
			"POST",
			"/api/sessions",
			{ email: bo.email, password: bo.password },
			undefined,
			null,
		);
		const boToken: string | undefined = boLogin.json?.token;
		check(
			"ownership",
			"setup: a second organizer signs up and logs in",
			success(boRegistered) &&
				typeof boId === "string" &&
				typeof boToken === "string",
			`expected 2xx { organizer: { id } } and 2xx { token }, got ${describe(boRegistered)} and ${describe(boLogin)}`,
		);

		expectNotYours(
			"another organizer cannot read the event",
			await send(
				"get as another organizer",
				"GET",
				`/api/events/${eventId}`,
				undefined,
				undefined,
				boToken,
			),
		);
		expectNotYours(
			"another organizer cannot change the event",
			await send(
				"change as another organizer",
				"PATCH",
				`/api/events/${eventId}`,
				{ title: "Taken over", capacity: 500 },
				undefined,
				boToken,
			),
		);
		const unchanged = await send(
			"get after the other organizer",
			"GET",
			`/api/events/${eventId}`,
		);
		check(
			"ownership",
			"the event is unchanged after another organizer tried to change it",
			success(unchanged) &&
				unchanged.json?.event?.title === title &&
				unchanged.json?.event?.capacity === party.capacity,
			`expected 2xx { event: { title: ${JSON.stringify(title)}, capacity: ${party.capacity} } }, got ${describe(unchanged)}`,
		);

		const boEvent = await send(
			"create as another organizer",
			"POST",
			"/api/events",
			{ title: "Bo's gig", slug: "bos-gig", capacity: 5 },
			undefined,
			boToken,
		);
		const boEventId: string | undefined = boEvent.json?.event?.id;
		check(
			"ownership",
			"an event belongs to the organizer of the token",
			success(boEvent) &&
				typeof boEventId === "string" &&
				organizerOf(boEvent.json?.event) === boId,
			`expected 2xx { event } whose organizer is ${boId}, got ${describe(boEvent)}`,
		);
		expectNotYours(
			"the first organizer cannot read the event of the second",
			await send("get the other's event", "GET", `/api/events/${boEventId}`),
		);

		const spoofed = await send(
			"create for another organizer",
			"POST",
			"/api/events",
			{
				...party,
				slug: "spoofed-event",
				organizerId: boId,
			},
		);
		check(
			"ownership",
			"an event cannot be created for another organizer",
			(spoofed.status >= 400 && spoofed.status < 500) ||
				(success(spoofed) && organizerOf(spoofed.json?.event) === organizerId),
			`expected a 4xx, or an event of ${organizerId}, got ${describe(spoofed)}`,
		);
	}

	// --- never a 5xx, on any request of the scenario ---
	const failures = exchanges.filter((exchange) => exchange.status >= 500);
	check(
		"problems",
		"no response is a 5xx",
		failures.length === 0,
		failures
			.map((exchange) => `${exchange.label}: ${describe(exchange)}`)
			.join("; "),
	);

	// --- sensitive values, in every response of the scenario ---
	for (const exchange of exchanges) {
		const leaks = leaksOf(exchange);
		check(
			"sensitive",
			`${exchange.label}: no password, plain or hashed`,
			leaks.length === 0,
			leaks.join("; "),
		);
	}

	const passed = Object.fromEntries(
		invariantsOf(brief).map((id) => [
			id,
			checks.filter((c) => c.invariant === id).every((c) => c.ok),
		]),
	) as Partial<Record<Invariant, boolean>>;
	return { brief, checks, passed };
}

/** What a response shows of a secret: a password sent, a hash, or a secret key that is not masked. */
function leaksOf(exchange: Exchange): string[] {
	const leaks: string[] = [];
	for (const password of SENT_PASSWORDS) {
		if (exchange.text.includes(password)) {
			leaks.push(
				`${exchange.label}: the plain password ${password} is in the body`,
			);
		}
	}
	if (HASH.test(exchange.text)) {
		leaks.push(`${exchange.label}: a password hash is in the body`);
	}
	const walk = (value: unknown, path: string) => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				walk(item, `${path}.${index}`);
			});
		} else if (typeof value === "object" && value !== null) {
			for (const [key, item] of Object.entries(value)) {
				if (SECRET_KEY.test(key) && typeof item === "string" && item !== MASK) {
					leaks.push(`${exchange.label}: ${path}.${key} is not masked`);
				}
				walk(item, `${path}.${key}`);
			}
		}
	};
	walk(exchange.json, "$");
	return leaks;
}
