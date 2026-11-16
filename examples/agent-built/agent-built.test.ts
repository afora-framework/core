import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractSpec, generate, loadSpec, normalizeSpec } from "@afora/codegen";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { z } from "zod";
import { stages } from "./catalogs.ts";
import {
	EVAL_JWT_SECRET,
	evaluate,
	type Handler,
	invariantsOf,
} from "./eval/invariants.ts";
import {
	evaluateBaseline,
	groupsOf,
	type RunResult,
	rateOf,
	resultsMarkdown,
	runEval,
} from "./eval/run.ts";
import { formatRate, wilson } from "./eval/stats.ts";
import { isApiError, makeRun } from "./scripts/eval.ts";
import { connectMcp, type RecordedCall } from "./scripts/mcp.ts";
import {
	baselineTurns,
	estimateRun,
	jobName,
	jobsOf,
	planOf,
	THINKING_PER_TURN,
} from "./scripts/plan.ts";
import {
	AGENT_INSTRUCTIONS,
	agentInstructions,
	BASELINE_TOOLS,
	baselineInstructions,
	CONTRACT_LINE,
} from "./scripts/prompts.ts";
import { readCalls, replay } from "./scripts/replay.ts";
import {
	briefText,
	MEMORY_SENTENCE,
	SQLITE_SENTENCE,
} from "./scripts/storage.ts";
import {
	BASELINE_TOOL_DEFINITIONS,
	baselineTools,
} from "./scripts/workspace.ts";
import { App } from "./src/domain";

// biome-ignore lint/suspicious/noExplicitAny: test helper reading JSON bodies
const body = (response: Response): Promise<any> => response.json();
const json = (value: unknown, token?: string, method = "POST") => ({
	method,
	headers: {
		"content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	},
	body: JSON.stringify(value),
});
const bearer = (token: string) => ({
	headers: { authorization: `Bearer ${token}` },
});

// the brief has the signing secret read from JWT_SECRET
process.env.JWT_SECRET = EVAL_JWT_SECRET;
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

	test("replaying runs/claude-code-2 through the MCP server gives the same afora.json and src/domain", async () => {
		const dir = ".tmp/test-replay";
		await replay(await readCalls("runs/claude-code-2/tool-calls.json"), dir);
		await sameFiles(dir);
	}, 60_000);
});

describe("the API", () => {
	const password = "Str0ng!pass";
	let organizerId = "";
	let eventId = "";
	let token = "";

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

	test("log in: 200 with a token, or 401 for a wrong password", async () => {
		const ok = await api.request(
			"/api/sessions",
			json({ email: "ana@example.com", password }),
		);
		expect(ok.status).toBe(200);
		token = (await body(ok)).token;
		expect(token.split(".")).toHaveLength(3);
		const bad = await api.request(
			"/api/sessions",
			json({ email: "ana@example.com", password: "Wr0ng!pass" }),
		);
		expect(bad.status).toBe(401);
		expect((await body(bad)).title).toBe("InvalidCredentials");
	});

	test("an event: 201 for the organizer of the token, 401 without one, 409 for a taken slug, 400 for an undeclared key", async () => {
		const party = { title: "Party", slug: "party", capacity: 2 };
		const anonymous = await api.request("/api/events", json(party));
		expect(anonymous.status).toBe(401);
		expect((await body(anonymous)).title).toBe("Unauthenticated");

		const created = await api.request("/api/events", json(party, token));
		expect(created.status).toBe(201);
		const { event } = await body(created);
		expect(event.organizer.id).toBe(organizerId);
		expect(event.organizer.password).toBe("********");
		eventId = event.id;

		expect((await api.request("/api/events", json(party, token))).status).toBe(
			409,
		);
		const spoofed = await api.request(
			"/api/events",
			json({ ...party, slug: "spoofed", organizerId }, token),
		);
		expect(spoofed.status).toBe(400);
		expect((await body(spoofed)).issues[0].code).toBe("undeclared_key");

		const read = await api.request(`/api/events/${eventId}`, bearer(token));
		expect(read.status).toBe(200);
		expect((await body(read)).event.slug).toBe("party");
		expect(
			(await api.request(`/api/events/${organizerId}`, bearer(token))).status,
		).toBe(404);
	});

	test("only its organizer reads or changes an event: another one gets a 404, as if it did not exist", async () => {
		const bo = { name: "Bo", email: "bo@example.com", password };
		expect((await api.request("/api/organizers", json(bo))).status).toBe(201);
		const login = await api.request(
			"/api/sessions",
			json({ email: bo.email, password }),
		);
		const other = (await body(login)).token;

		const read = await api.request(`/api/events/${eventId}`, bearer(other));
		expect(read.status).toBe(404);
		expect((await body(read)).title).toBe("EventNotFound");
		const change = await api.request(
			`/api/events/${eventId}`,
			json({ title: "Taken over" }, other, "PATCH"),
		);
		expect(change.status).toBe(404);

		const renamed = await api.request(
			`/api/events/${eventId}`,
			json({ title: "Party night" }, token, "PATCH"),
		);
		expect(renamed.status).toBe(200);
		expect((await body(renamed)).event.title).toBe("Party night");
		expect(
			(
				await api.request(
					`/api/events/${eventId}`,
					json({ slug: "renamed" }, token, "PATCH"),
				)
			).status,
		).toBe(400);
		expect(
			(await api.request(`/api/events/${eventId}`, bearer("not-a-token")))
				.status,
		).toBe(401);
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

	test("/openapi.json documents the routes of the brief, and which need a token", async () => {
		const document = await body(await api.request("/openapi.json"));
		expect(Object.keys(document.paths).sort()).toEqual([
			"/api/events",
			"/api/events/{eventId}/tickets",
			"/api/events/{id}",
			"/api/organizers",
			"/api/sessions",
		]);
		expect(Object.keys(document.paths["/api/events/{id}"]).sort()).toEqual([
			"get",
			"patch",
		]);
		const secured = (path: string, method: string) =>
			(document.paths[path][method].security ?? []).length > 0;
		expect(secured("/api/events", "post")).toBe(true);
		expect(secured("/api/events/{id}", "get")).toBe(true);
		expect(secured("/api/events/{id}", "patch")).toBe(true);
		expect(secured("/api/organizers", "post")).toBe(false);
		expect(secured("/api/events/{eventId}/tickets", "post")).toBe(false);
	});
});

/**
 * An API that answers the routes of the brief and breaks each invariant: it
 * returns the hash, ignores unknown keys, lets duplicates in, throws on
 * business errors and hands out a token it never checks. The checks must
 * catch all of it.
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
		return c.json({ organizer, token: `token-${organizer.id}` });
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
	app.patch("/events/:id", async (c) => {
		const event = events.find((e) => e.id === c.req.param("id"));
		if (!event) throw new Error("no such event");
		Object.assign(event, await c.req.json());
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
			ownership: false,
			concurrency: false,
		});
		expect(checks.filter((c) => !c.ok).length).toBeGreaterThan(10);
	});

	test("brief 3 is checked for every invariant, ownership and concurrency included, and both fail on the careless API", async () => {
		expect(invariantsOf(3)).toEqual(invariantsOf(2));
		expect(invariantsOf(3)).toContain("ownership");
		expect(invariantsOf(1)).toContain("concurrency");
		const v3 = await evaluate(careless(), 3);
		expect(v3.passed.ownership).toBe(false);
		expect(v3.passed.concurrency).toBe(false);
		const v1 = await evaluate(careless(), 1);
		expect(v1.passed.concurrency).toBe(false);
		expect(v1.passed.ownership).toBeUndefined();
		// the careless API sells every seat asked for
		const oversold = v3.checks.find(
			(c) =>
				c.name === "four buyers at once never get more than the two seats left",
		);
		expect(oversold?.ok).toBe(false);
		expect(oversold?.detail).toContain("4 tickets sold for 2 seats left");
	});

	test("concurrency fails on an API that checks the capacity, then awaits, then sells", async () => {
		// the committed app, but its tickets route replaced by a racy one
		const sold = new Map<string, number>();
		const racy: Handler = async (request) => {
			const match = /\/api\/events\/([^/]+)\/tickets$/.exec(
				new URL(request.url).pathname,
			);
			if (!match || request.method !== "POST") return api.fetch(request);
			const id = match[1] as string;
			const event = await api.fetch(
				new Request(`http://x/api/events/${id}`, {
					headers: {
						authorization: request.headers.get("authorization") ?? "",
					},
				}),
			);
			const capacity = event.ok ? (await body(event)).event.capacity : 3;
			const taken = sold.get(id) ?? 0;
			if (taken >= capacity) {
				return Response.json(
					{ type: "about:blank", title: "SoldOut", status: 422 },
					{
						status: 422,
						headers: { "content-type": "application/problem+json" },
					},
				);
			}
			await Bun.sleep(5); // the read and the write are apart
			sold.set(id, (sold.get(id) ?? 0) + 1);
			return Response.json(
				{ ticket: { id: crypto.randomUUID() } },
				{ status: 201 },
			);
		};
		const { passed } = await evaluate(racy, 1);
		expect(passed.concurrency).toBe(false);
	});

	test("the non-scripted runs still evaluate: every afora run of them passes every invariant, and eval/RESULTS.md is what the runs give", async () => {
		const results = await runEval();
		for (const name of ["claude-code-1", "claude-code-2"]) {
			for (const side of ["afora", "baseline"] as const) {
				const result = results.find(
					(r) => r.run === name && r.implementation === side,
				);
				expect(result?.scripted).toBe(false);
				expect(result?.error).toBeUndefined();
			}
		}
		// scripted afora runs that fail are results, reported in RESULTS.md
		const afora = results.filter(
			(r) => r.implementation === "afora" && !r.scripted,
		);
		expect(afora.length).toBeGreaterThan(0);
		for (const result of afora) {
			expect({ run: result.run, error: result.error }).toEqual({
				run: result.run,
				error: undefined,
			});
			for (const id of invariantsOf(result.brief)) {
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
		const before = await runCount();
		for (const script of ["build-with-agent", "build-baseline", "eval"]) {
			const child = Bun.spawn(["bun", `scripts/${script}.ts`, "--runs", "1"], {
				env,
				stderr: "pipe",
				stdout: "pipe",
			});
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited).toBe(1);
			expect(stderr).toContain("ANTHROPIC_API_KEY is not set");
		}
		const multi = Bun.spawn(
			[
				"bun",
				"scripts/eval.ts",
				"--runs",
				"20",
				"--models",
				"claude-opus-5-5,claude-sonnet-5-5",
				"--briefs",
				"2,3",
				"--db",
				"sqlite",
			],
			{ env, stderr: "pipe", stdout: "pipe" },
		);
		const stderr = await new Response(multi.stderr).text();
		expect(await multi.exited).toBe(1);
		expect(stderr).toContain("ANTHROPIC_API_KEY is not set");
		expect(await runCount()).toBe(before);
	});

	test("--dry-run prints the plan and a token estimate without a key, and writes no run", async () => {
		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		const before = await runCount();
		const child = Bun.spawn(
			[
				"bun",
				"scripts/eval.ts",
				"--runs",
				"20",
				"--models",
				"claude-opus-5-5,claude-sonnet-5-5",
				"--briefs",
				"2,3",
				"--dry-run",
			],
			{ env, stderr: "pipe", stdout: "pipe" },
		);
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(stdout).toContain(
			"Plan: 20 runs per side, model, brief and database: 160 runs.",
		);
		expect(stdout).toContain("claude-opus-5-5, claude-sonnet-5-5");
		expect(stdout).toMatch(/total\s+160\s+~[\d,]+\s+~[\d,]+\s+~[\d,]+/);
		expect(stdout).toContain("no model was called");
		expect(await runCount()).toBe(before);
	}, 60_000);
});

/** The run directories of both sides, to show a script made none. */
async function runCount(): Promise<number> {
	let count = 0;
	for (const parent of ["runs", "baseline/runs"]) {
		count += (await readdir(parent)).length;
	}
	return count;
}

describe("the plan of the scripted evaluation", () => {
	test("N runs per side, model, brief and database", () => {
		const plan = planOf(
			[
				"--runs",
				"20",
				"--models",
				"claude-opus-5-5,claude-sonnet-5-5",
				"--briefs",
				"2,3",
				"--db",
				"memory,sqlite",
			],
			{},
		);
		expect(plan.models).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
		expect(plan.briefs).toEqual([2, 3]);
		expect(plan.dbs).toEqual(["memory", "sqlite"]);
		const jobs = jobsOf(plan);
		expect(jobs).toHaveLength(20 * 2 * 2 * 2 * 2);
		const per = new Map<string, number>();
		for (const job of jobs) {
			const key = `${job.model}/${job.brief}/${job.db}/${job.side}`;
			per.set(key, (per.get(key) ?? 0) + 1);
		}
		expect([...per.values()].every((count) => count === 20)).toBe(true);
		expect(per.size).toBe(16);
		// afora and baseline runs live in different directories
		expect(
			new Set(jobs.map((job) => `${job.side}/${jobName(job, "stamp")}`)).size,
		).toBe(jobs.length);
		expect(jobName(jobs[0] as (typeof jobs)[0], "2026-11-15T10-00-00")).toBe(
			"2026-11-15T10-00-00-claude-opus-5-5-b2-memory-1",
		);
	});

	test("defaults, and refusals of a bad flag", () => {
		const plan = planOf([], {});
		expect(plan).toMatchObject({
			runs: 20,
			models: ["claude-opus-5-5"],
			briefs: [2],
			dbs: ["memory"],
			sides: ["afora", "baseline"],
			effort: "high",
			dryRun: false,
			evaluate: true,
		});
		expect(planOf([], { AFORA_EVAL_MODEL: "claude-x" }).models).toEqual([
			"claude-x",
		]);
		expect(() => planOf(["--briefs", "4"], {})).toThrow("--briefs");
		expect(() => planOf(["--db", "postgres"], {})).toThrow("--db");
		expect(() => planOf(["--runs", "0"], {})).toThrow("--runs");
		expect(() => planOf(["--sides", "zod"], {})).toThrow("--sides");
		expect(() => planOf(["--unknown"], {})).toThrow();
	});

	test("the estimate grows with the conversation; both sides run the same loop", () => {
		const turns = [
			{ call: 400, result: 4_000 },
			{ call: 400, result: 4_000 },
		];
		const run = estimateRun({ fixed: 40_000, turns });
		expect(run.requests).toBe(3);
		// 3 requests of the fixed part (10,000 tokens), then the history
		expect(run.input).toBeGreaterThan(30_000 + 2 * 1_000);
		expect(run.output).toBe(
			2 * (100 + THINKING_PER_TURN) + 50 + THINKING_PER_TURN,
		);
		const baseline = estimateRun({ fixed: 4_000, turns: baselineTurns(8_000) });
		expect(baseline.requests).toBe(7);
		expect(estimateRun({ fixed: 4_000, turns: [] })).toEqual({
			requests: 1,
			input: 1_000,
			output: 50 + THINKING_PER_TURN,
		});
	});
});

describe("RESULTS.md", () => {
	test("wilson gives the 95% interval of a pass rate", () => {
		const all = wilson(20, 20);
		expect(all.high).toBe(1);
		expect(all.low).toBeCloseTo(0.8389, 3);
		const none = wilson(0, 20);
		expect(none.low).toBe(0);
		expect(none.high).toBeCloseTo(0.1611, 3);
		const half = wilson(10, 20);
		expect(half.low).toBeCloseTo(0.2993, 3);
		expect(half.high).toBeCloseTo(0.7007, 3);
		expect(formatRate(wilson(18, 20))).toBe("18/20 (90%; 70%–97%)");
		expect(formatRate(wilson(0, 0))).toBe("not in brief");
		expect(() => wilson(3, 2)).toThrow();
	});

	test("pass rates per invariant, grouped by model, brief, database and side, scripted runs apart", () => {
		const run = (
			implementation: "afora" | "baseline",
			index: number,
			model: string,
			passed: Partial<Record<string, boolean>>,
		): RunResult => ({
			implementation,
			run: `s-${model}-${implementation}-${index}`,
			brief: 3,
			db: "sqlite",
			model,
			effort: "high",
			scripted: true,
			checks: [],
			passed: {
				sensitive: true,
				undeclared: true,
				problems: true,
				unique: true,
				ownership: true,
				concurrency: true,
				...passed,
			},
		});
		const results = [
			run("afora", 1, "m-a", {}),
			run("afora", 2, "m-a", {}),
			run("baseline", 1, "m-a", { undeclared: false }),
			run("baseline", 2, "m-a", {}),
			run("baseline", 1, "m-b", { concurrency: false }),
			{ ...run("baseline", 3, "m-b", {}), effort: "max" },
		];
		const groups = groupsOf(results);
		expect(
			groups.map(
				(g) => `${g.model}/${g.effort}/${g.brief}/${g.db}/${g.implementation}`,
			),
		).toEqual([
			"m-a/high/3/sqlite/afora",
			"m-a/high/3/sqlite/baseline",
			"m-b/high/3/sqlite/baseline",
			"m-b/max/3/sqlite/baseline",
		]);
		const baseline = groups[1]?.runs ?? [];
		expect(rateOf(baseline, "undeclared")).toMatchObject({
			passed: 1,
			runs: 2,
		});
		expect(rateOf(baseline, "all")).toMatchObject({ passed: 1, runs: 2 });
		const markdown = resultsMarkdown(results);
		expect(markdown).toContain("## Scripted runs");
		expect(markdown).toContain(
			"| m-a | high | 3 | sqlite | baseline | 2 | 2/2 (100%; 34%–100%) | 1/2 (50%; 9%–91%) |",
		);
		expect(markdown).not.toContain("None yet");
	});
});

describe("on SQLite", () => {
	const drizzle = {
		use: "drizzle",
		options: {
			db: { import: "../db.ts#db" },
			tables: { import: "../db.ts#tables" },
		},
	};

	test("the brief and the instructions say SQLite; brief 3 lists no guarantee", async () => {
		for (const version of [1, 2, 3] as const) {
			const memory = await briefText(version);
			expect(memory).toContain(MEMORY_SENTENCE);
			const sqlite = await briefText(version, "sqlite");
			expect(sqlite).toContain(SQLITE_SENTENCE);
			expect(sqlite).not.toContain(MEMORY_SENTENCE);
		}
		const v3 = await briefText(3);
		for (const guarantee of [
			"never",
			"Unknown fields",
			"cannot share",
			"5xx",
			"********",
			"hash",
		]) {
			expect(v3).not.toContain(guarantee);
		}
		expect(agentInstructions("sqlite")).toContain('"use": "drizzle"');
		expect(agentInstructions("sqlite")).not.toContain('"inMemory"');
		expect(baselineInstructions("sqlite")).toContain("bun:sqlite");
		expect(baselineInstructions("sqlite")).not.toContain("in memory");
	});

	test("both sides get the same contract line and a loop with tools; brief 2 keeps its instructions, brief 3 names no guarantee on either side", () => {
		expect(agentInstructions("memory", 2)).toBe(AGENT_INSTRUCTIONS);
		for (const db of ["memory", "sqlite"] as const) {
			for (const brief of [2, 3] as const) {
				expect(agentInstructions(db, brief)).toContain(CONTRACT_LINE);
				expect(baselineInstructions(db, brief)).toContain(CONTRACT_LINE);
				for (const tool of BASELINE_TOOLS) {
					expect(baselineInstructions(db, brief)).toContain(tool);
				}
			}
			for (const text of [
				agentInstructions(db, 3),
				baselineInstructions(db, 3),
			]) {
				for (const guarantee of [
					"rejects undeclared",
					"masks",
					"sensitive",
					"problem+json",
					"unique",
					"transaction",
					"409",
					"5xx",
				]) {
					expect(text).not.toContain(guarantee);
				}
			}
		}
		expect(BASELINE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
			...BASELINE_TOOLS,
		]);
	});

	test("the MCP server offers the drizzle provider to a run on SQLite, and only to it", async () => {
		const dir = ".tmp/test-catalog";
		await mkdir(dir, { recursive: true });
		for (const db of ["memory", "sqlite"] as const) {
			const mcp = await connectMcp(dir, db);
			try {
				const catalog = await mcp.callTool("afora_catalog", {});
				expect(catalog.isError).toBe(false);
				expect(catalog.text.includes("@afora/drizzle")).toBe(db === "sqlite");
			} finally {
				await mcp.close();
			}
		}
	});

	test("the calls of runs/claude-code-2 with the drizzle provider give an app on SQLite that holds every invariant", async () => {
		const calls = (await readCalls("runs/claude-code-2/tool-calls.json")).map(
			(call): RecordedCall =>
				"tool" in call && call.tool === "afora_spec_write"
					? {
							...call,
							arguments: {
								spec: {
									...(call.arguments.spec as object),
									provider: drizzle,
								},
							},
						}
					: call,
		);
		const dir = ".tmp/test-sqlite";
		await replay(calls, dir, { db: "sqlite" });
		expect(existsSync(join(dir, "src/db.ts"))).toBe(true);
		expect(
			await readFile(join(dir, "src/domain/application.ts"), "utf8"),
		).toContain("drizzleProvider({ db, tables })");

		const file = resolve(".tmp/test-sqlite.sqlite");
		await rm(file, { force: true });
		const child = Bun.spawn(
			["bun", "eval/check.ts", "afora", dir, "2", "sqlite"],
			{
				env: { ...process.env, DATABASE_PATH: file },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code: await child.exited, stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		const evaluation = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
		expect(evaluation.passed).toEqual({
			sensitive: true,
			undeclared: true,
			problems: true,
			unique: true,
			ownership: true,
			concurrency: true,
		});
		// the data is in the file: 2 tickets of the first event, 3 of the last seats
		const sqlite = new Database(file, { readonly: true });
		try {
			const { count } = sqlite
				.query("SELECT count(*) AS count FROM tickets")
				.get() as { count: number };
			expect(count).toBe(5);
		} finally {
			sqlite.close();
		}
	}, 120_000);
});

describe("the baseline's tools", () => {
	// three levels down, like baseline/runs/<name>, so its tsconfig extends ours
	const project = resolve(".tmp/tools/baseline/project");
	const write = (content: string) =>
		call("write_file", { path: "app.ts", content });
	const call = baselineTools(project, "memory", { smokeTimeoutMs: 5_000 });

	test("write and read files inside the project only, type-check them, and smoke the app", async () => {
		await rm(project, { recursive: true, force: true });
		await mkdir(project, { recursive: true });
		await Bun.write(
			join(project, "tsconfig.json"),
			JSON.stringify({
				extends: "../../../../tsconfig.json",
				include: ["**/*.ts"],
				exclude: ["node_modules"],
			}),
		);
		for (const path of ["../escape.ts", "/tmp/x.ts", "node_modules/x.ts"]) {
			expect((await call("write_file", { path, content: "" })).isError).toBe(
				true,
			);
		}
		expect((await call("smoke", { requests: [] })).text).toContain("no app.ts");
		expect(
			(
				await write(
					await readFile("baseline/runs/claude-code-2/app.ts", "utf8"),
				)
			).isError,
		).toBe(false);
		expect((await call("list_files", {})).text).toBe("app.ts\ntsconfig.json");
		expect((await call("read_file", { path: "app.ts" })).text).toContain(
			"export default app",
		);
		expect(await call("check", {})).toEqual({
			isError: false,
			text: "No diagnostics.",
		});
		const smoke = await call("smoke", {
			requests: [
				{
					method: "POST",
					path: "/api/organizers",
					body: {
						name: "Ana",
						email: "ana@example.com",
						password: "Tick3t!pass",
					},
				},
				{ path: "/api/events/nope" },
			],
		});
		expect(smoke.isError).toBe(false);
		const answers = JSON.parse(smoke.text);
		expect(answers.map((a: { status: number }) => a.status)).toEqual([
			201, 401,
		]);

		await write(
			"const n: number = 'one';\nexport default { fetch: () => new Promise<Response>(() => {}) };\n",
		);
		const check = await call("check", {});
		expect(check.isError).toBe(true);
		expect(check.text).toContain("TS2322");
		const hung = await call("smoke", { requests: [{ path: "/" }] });
		expect(hung).toEqual({
			isError: true,
			text: "The app did not answer within 5 seconds.",
		});
	}, 60_000);
});

describe("failures of the harness", () => {
	const root = resolve(".tmp/test-make");
	const throwing = (error: unknown) =>
		({
			beta: {
				messages: {
					stream: () => ({ finalMessage: () => Promise.reject(error) }),
				},
			},
		}) as unknown as Parameters<typeof makeRun>[0];
	const job = {
		side: "baseline" as const,
		model: "m",
		brief: 2 as const,
		db: "memory" as const,
		index: 1,
	};
	const plan = { effort: "high" as const, maxTurns: 3 };

	test("an API error is retried from scratch, then the run is left out", async () => {
		await rm(root, { recursive: true, force: true });
		let calls = 0;
		const client = {
			beta: {
				messages: {
					stream: () => {
						calls++;
						return {
							finalMessage: () =>
								Promise.reject(
									new Anthropic.APIConnectionError({ message: "down" }),
								),
						};
					},
				},
			},
		} as unknown as Parameters<typeof makeRun>[0];
		expect(isApiError(new Anthropic.APIConnectionError({ message: "x" }))).toBe(
			true,
		);
		expect(
			await makeRun(client, plan, job, "api", { root, backoffMs: 1 }),
		).toBe(undefined);
		expect(calls).toBe(3);
		expect(existsSync(join(root, "baseline/runs/api"))).toBe(false);
	});

	test("any other failure keeps the run, which then fails every invariant", async () => {
		const outcome = await makeRun(
			throwing(new TypeError("the harness broke")),
			plan,
			job,
			"broken",
			{ root, backoffMs: 1 },
		);
		expect(outcome).toBe("failed: the harness broke");
		const json = JSON.parse(
			await readFile(join(root, "baseline/runs/broken/run.json"), "utf8"),
		);
		expect(json).toMatchObject({
			brief: 2,
			scripted: true,
			error: "the harness broke",
		});
		const result = await evaluateBaseline("broken", { root });
		expect(result.error).toContain("the harness broke");
		expect(Object.values(result.passed)).toEqual(
			invariantsOf(2).map(() => false),
		);
	});

	test("an evaluation that takes too long fails the run", async () => {
		const dir = join(root, "baseline/runs/slow");
		await mkdir(dir, { recursive: true });
		await Bun.write(
			join(dir, "run.json"),
			JSON.stringify({
				brief: 2,
				db: "memory",
				model: "m",
				effort: "high",
				scripted: true,
			}),
		);
		await Bun.write(
			join(dir, "app.ts"),
			"export default { fetch: () => new Promise<Response>(() => {}) };\n",
		);
		const started = Date.now();
		const result = await evaluateBaseline("slow", { root, timeoutMs: 3_000 });
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(result.error).toBe("The evaluation timed out after 3 seconds.");
		expect(Object.values(result.passed).every((ok) => ok === false)).toBe(true);
	}, 30_000);
});
