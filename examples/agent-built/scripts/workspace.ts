/**
 * The tools of a baseline run, over its project directory: the feedback a
 * baseline gets in place of afora_spec_validate and afora_generate. Files
 * stay inside the directory; `check` runs tsc as afora_generate does, and
 * `smoke` loads app.ts in a fresh process and sends it requests.
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolResult } from "./mcp.ts";
import type { Db } from "./storage.ts";

const ROOT = resolve(import.meta.dir, "..");
/** The JWT secret of smoke requests: not the one of the evaluation. */
export const SMOKE_JWT_SECRET = "smoke-requests-secret-of-the-baseline-0123";
const SMOKE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 180_000;
const MAX_FILE = 200_000;

export const BASELINE_TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
	{
		name: "write_file",
		description:
			"Writes a file of the project (a path relative to the project directory), replacing it if it exists.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "e.g. app.ts" },
				content: { type: "string" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "read_file",
		description: "Reads a file of the project.",
		input_schema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
	{
		name: "list_files",
		description: "Lists the files of the project.",
		input_schema: { type: "object", properties: {} },
	},
	{
		name: "check",
		description:
			"Type-checks the project with `tsc --noEmit -p <project>` and gives the diagnostics, or says there are none.",
		input_schema: { type: "object", properties: {} },
	},
	{
		name: "smoke",
		description:
			"Loads app.ts in a fresh process and sends the requests, in order, to the fetch handler of its default export; gives back the status, content type and body (first 2000 characters) of each, or what it threw. State is kept between the requests of one call, not between calls.",
		input_schema: {
			type: "object",
			properties: {
				requests: {
					type: "array",
					items: {
						type: "object",
						properties: {
							method: { type: "string", description: "GET by default" },
							path: { type: "string", description: "e.g. /api/organizers" },
							headers: {
								type: "object",
								additionalProperties: { type: "string" },
							},
							body: {
								description:
									"Sent as JSON; a string is sent as it is (content-type application/json).",
							},
						},
						required: ["path"],
					},
				},
			},
			required: ["requests"],
		},
	},
];

const ok = (text: string): ToolResult => ({ isError: false, text });
const fail = (text: string): ToolResult => ({ isError: true, text });

/** A path of the project, or undefined when it leaves it. */
function inside(project: string, path: unknown): string | undefined {
	if (typeof path !== "string" || path === "" || isAbsolute(path)) return;
	const full = resolve(project, normalize(path));
	const rel = relative(project, full);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
	if (rel.split(/[\\/]/).includes("node_modules")) return;
	return full;
}

async function filesOf(dir: string, base = dir): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await filesOf(full, base)));
		else files.push(relative(base, full));
	}
	return files.sort();
}

/** The environment of a command the agent's code runs in: no API credentials. */
function cleanEnv(
	env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const copy = { ...env };
	for (const key of Object.keys(copy)) {
		if (key.startsWith("ANTHROPIC_")) delete copy[key];
	}
	return copy;
}

/** Runs a command with a timeout; gives its output and code. */
async function run(
	command: string[],
	options: {
		cwd: string;
		env?: Record<string, string | undefined>;
		stdin?: string;
		timeoutMs: number;
	},
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: cleanEnv(options.env),
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, options.timeoutMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return { code, output: `${stdout}${stderr}`, timedOut };
}

/** The tools of a baseline run on `project`, as a call function for the loop. */
export function baselineTools(
	project: string,
	db: Db,
	{ smokeTimeoutMs = SMOKE_TIMEOUT_MS }: { smokeTimeoutMs?: number } = {},
) {
	return async (
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolResult> => {
		switch (name) {
			case "write_file": {
				const file = inside(project, args.path);
				if (!file)
					return fail(
						"The path must be relative and stay inside the project (not node_modules).",
					);
				if (typeof args.content !== "string")
					return fail('"content" must be a string.');
				if (args.content.length > MAX_FILE)
					return fail(`A file is at most ${MAX_FILE} characters.`);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, args.content);
				return ok(
					`Wrote ${relative(project, file)} (${args.content.length} characters).`,
				);
			}
			case "read_file": {
				const file = inside(project, args.path);
				if (!file)
					return fail("The path must be relative and stay inside the project.");
				try {
					return ok(await readFile(file, "utf8"));
				} catch {
					return fail(`No file ${String(args.path)}.`);
				}
			}
			case "list_files":
				return ok((await filesOf(project)).join("\n") || "(empty)");
			case "check": {
				const result = await run(
					["bunx", "--no-install", "tsc", "--noEmit", "-p", project],
					{ cwd: project, timeoutMs: CHECK_TIMEOUT_MS },
				);
				if (result.timedOut) return fail("tsc timed out.");
				const output = result.output.trim();
				if (result.code === 0) return ok("No diagnostics.");
				return fail(output.slice(0, 20_000) || `tsc exited ${result.code}.`);
			}
			case "smoke": {
				if (!Array.isArray(args.requests))
					return fail('"requests" must be a list.');
				if (
					!inside(project, "app.ts") ||
					!(await filesOf(project)).includes("app.ts")
				) {
					return fail("There is no app.ts yet.");
				}
				const scratch = await mkdtemp(join(tmpdir(), "afora-smoke-"));
				try {
					const env: Record<string, string | undefined> = {
						...process.env,
						JWT_SECRET: SMOKE_JWT_SECRET,
					};
					delete env.DATABASE_PATH;
					if (db === "sqlite")
						env.DATABASE_PATH = join(scratch, "smoke.sqlite");
					const result = await run(
						[
							"bun",
							join(ROOT, "scripts/smoke-app.ts"),
							join(project, "app.ts"),
						],
						{
							cwd: project,
							env,
							stdin: JSON.stringify(args.requests),
							timeoutMs: smokeTimeoutMs,
						},
					);
					if (result.timedOut)
						return fail(
							`The app did not answer within ${smokeTimeoutMs / 1000} seconds.`,
						);
					if (result.code !== 0)
						return fail(result.output.trim().slice(0, 20_000));
					return ok(result.output.trim().slice(0, 40_000));
				} finally {
					await rm(scratch, { recursive: true, force: true });
				}
			}
			default:
				return fail(`Unknown tool ${name}.`);
		}
	};
}
