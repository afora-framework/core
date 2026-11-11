import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractSpec, generate, loadSpec, normalizeSpec } from "@afora/codegen";
import { Hono } from "hono";
import { z } from "zod";
import { stages } from "./catalogs.ts";
import { evaluate, type Handler, INVARIANT_IDS } from "./eval/invariants.ts";
import { resultsMarkdown, runEval } from "./eval/run.ts";
import { readCalls, replay } from "./scripts/replay.ts";
import { App } from "./src/domain";

// biome-ignore lint/suspicious/noExplicitAny: test helper reading JSON bodies
const body = (response: Response): Promise<any> => response.json();
const json = (value: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(value),
});

await App.start();
const api = App.outputs.Api.build();

async function sameFiles(dir: string) {
	expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(
		await readFile("afora.json", "utf8"),
	);
	const committed = (await readdir("src/domain")).sort();
	expect((await readdir(join(dir, "src/domain"))).sort()).toEqual(committed);
	for (const name of committed) {
		expect(await readFile(join(dir, "src/domain", name), "utf8")).toBe(
			await readFile(join("src/domain", name), "utf8"),
		);
	}
}

describe("the committed app", () => {
	test("src/domain equals what afora.json generates (no drift)", async () => {
		const { spec, extended } = await loadSpec("afora.json");
		const files = generate(spec, extended, { stages });
		const committed = (await readdir("src/domain")).sort();
		expect(files.map((file) => file.path.split("/").pop()).sort()).toEqual(
			committed,
		);
		for (const file of files) {
			const name = file.path.split("/").pop() as string;
			expect(await readFile(join("src/domain", name), "utf8")).toBe(
				file.contents,
			);
		}
	});

	test("extractSpec(App) gives back afora.json", async () => {
		const { spec } = await loadSpec("afora.json");
		expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(spec));
	});

	test("replaying runs/claude-code-1 through the MCP server gives the same afora.json and src/domain", async () => {
		const dir = ".tmp/test-replay";
		await replay(await readCalls("runs/claude-code-1/tool-calls.json"), dir);
		await sameFiles(dir);
	}, 60_000);
});

describe("the API", () => {
	const password = "Str0ng!pass";
	let organizerId = "";
	let eventId = "";

	test("sign up answers 201 with the password masked; a taken email is a 409", async () => {
		const ana = { name: "Ana", email: "ana@example.com", password };
		const response = await api.request("/api/organizers", json(ana));
		expect(response.status).toBe(201);
		const { organizer } = await body(response);
		expect(organizer.password).toBe("********");
		organizerId = organizer.id;

		const again = await api.request("/api/organizers", json(ana));
		expect(again.status).toBe(409);
		expect(again.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect((await body(again)).title).toBe("EmailTaken");
	});

	test("log in: 200, or 401 for a wrong password", async () => {
		const ok = await api.request(
			"/api/sessions",
			json({ email: "ana@example.com", password }),
		);
		expect(ok.status).toBe(200);
		const bad = await api.request(
			"/api/sessions",
			json({ email: "ana@example.com", password: "Wr0ng!pass" }),
		);
		expect(bad.status).toBe(401);
		expect((await body(bad)).title).toBe("InvalidCredentials");
	});

	test("an event: 201, 409 for a taken slug, 404 for an unknown organizer, 400 for an undeclared key", async () => {
		const party = { organizerId, title: "Party", slug: "party", capacity: 2 };
		const created = await api.request("/api/events", json(party));
		expect(created.status).toBe(201);
		const { event } = await body(created);
		expect(event.organizer.id).toBe(organizerId);
		expect(event.organizer.password).toBe("********");
		eventId = event.id;

		expect((await api.request("/api/events", json(party))).status).toBe(409);
		const orphan = await api.request(
			"/api/events",
			json({ ...party, slug: "orphan", organizerId: eventId }),
		);
		expect(orphan.status).toBe(404);
		expect((await body(orphan)).title).toBe("OrganizerNotFound");
		const extra = await api.request(
			"/api/events",
			json({ ...party, slug: "extra", price: 10 }),
		);
		expect(extra.status).toBe(400);
		expect((await body(extra)).issues[0].code).toBe("undeclared_key");

		const read = await api.request(`/api/events/${eventId}`);
		expect(read.status).toBe(200);
		expect((await body(read)).event.slug).toBe("party");
		expect((await api.request(`/api/events/${organizerId}`)).status).toBe(404);
	});

	test("tickets sell up to the capacity, then SoldOut is a 422 and rolls the extra ticket back", async () => {
		const buy = (buyerEmail: string) =>
			api.request(`/api/events/${eventId}/tickets`, json({ buyerEmail }));
		expect((await buy("bea@example.com")).status).toBe(201);
		const second = await buy("caio@example.com");
		expect(second.status).toBe(201);
		expect((await body(second)).ticket.event.id).toBe(eventId);
		for (const buyer of ["dan@example.com", "eva@example.com"]) {
			const refused = await buy(buyer);
			expect(refused.status).toBe(422);
			expect((await body(refused)).title).toBe("SoldOut");
		}
		const unknown = await api.request(
			`/api/events/${organizerId}/tickets`,
			json({ buyerEmail: "fay@example.com" }),
		);
		expect(unknown.status).toBe(404);
		expect((await body(unknown)).title).toBe("EventNotFound");
	});

	test("/openapi.json documents the routes of the brief", async () => {
		const document = await body(await api.request("/openapi.json"));
		expect(Object.keys(document.paths).sort()).toEqual([
			"/api/events",
			"/api/events/{eventId}/tickets",
			"/api/events/{id}",
			"/api/organizers",
			"/api/sessions",
		]);
	});
});

/**
 * An API that answers the routes of the brief and breaks each invariant: it
 * returns the hash, ignores unknown keys, lets duplicates in and throws on
 * business errors. The checks must catch all of it.
 */
function careless(): Handler {
	const app = new Hono().basePath("/api");
	const organizers: Record<string, unknown>[] = [];
	const events: Record<string, unknown>[] = [];
	const Organizer = z.object({
		name: z.string(),
		email: z.string(),
		password: z.string(),
	});
	app.post("/organizers", async (c) => {
		const input = Organizer.parse(await c.req.json());
		const organizer = {
			id: crypto.randomUUID(),
			...input,
			password: await Bun.password.hash(input.password),
		};
		organizers.push(organizer);
		return c.json({ organizer }, 201);
	});
	app.post("/sessions", async (c) => {
		const { email } = await c.req.json();
		const organizer = organizers.find((o) => o.email === email);
		if (!organizer) throw new Error("no such organizer");
		return c.json({ organizer });
	});
	app.post("/events", async (c) => {
		const event = { id: crypto.randomUUID(), ...(await c.req.json()) };
		events.push(event);
		return c.json({ event }, 201);
	});
	app.get("/events/:id", (c) => {
		const event = events.find((e) => e.id === c.req.param("id"));
		if (!event) throw new Error("no such event");
		return c.json({ event });
	});
	app.post("/events/:id/tickets", async (c) => {
		const ticket = { id: crypto.randomUUID(), ...(await c.req.json()) };
		return c.json({ ticket }, 201);
	});
	app.onError((error, c) => c.text(error.message, 500));
	return (request) => app.fetch(request);
}

describe("the evaluation", () => {
	test("the checks catch an API that breaks every invariant", async () => {
		const { passed, checks } = await evaluate(careless());
		expect(passed).toEqual({
			sensitive: false,
			undeclared: false,
			problems: false,
			unique: false,
		});
		expect(checks.filter((c) => !c.ok).length).toBeGreaterThan(10);
	});

	test("every afora run passes every invariant, and eval/RESULTS.md is what the runs give", async () => {
		const results = await runEval();
		const afora = results.filter((r) => r.implementation === "afora");
		expect(afora.length).toBeGreaterThan(0);
		for (const result of afora) {
			expect({ run: result.run, error: result.error }).toEqual({
				run: result.run,
				error: undefined,
			});
			for (const id of INVARIANT_IDS) {
				expect({
					run: result.run,
					invariant: id,
					passed: result.passed[id],
				}).toEqual({ run: result.run, invariant: id, passed: true });
			}
		}
		// baseline failures are results, reported in RESULTS.md, not test failures
		expect(resultsMarkdown(results)).toBe(
			await readFile("eval/RESULTS.md", "utf8"),
		);
	}, 180_000);

	test("the scripts that call a model exit without running anything when there is no key", async () => {
		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		for (const script of ["build-with-agent", "build-baseline"]) {
			const child = Bun.spawn(["bun", `scripts/${script}.ts`, "--runs", "1"], {
				env,
				stderr: "pipe",
				stdout: "pipe",
			});
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited).toBe(1);
			expect(stderr).toContain("ANTHROPIC_API_KEY is not set");
		}
	});
});
