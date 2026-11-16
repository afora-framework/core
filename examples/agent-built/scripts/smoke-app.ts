/**
 * The `smoke` tool of a baseline run, in its own process: imports app.ts (its
 * default export, or `app`), sends the requests read from stdin to its fetch
 * handler in order, and prints what came back as JSON.
 *
 *   echo '[{"method":"POST","path":"/api/organizers","body":{...}}]' | bun scripts/smoke-app.ts <app.ts>
 */
import { resolve } from "node:path";

interface SmokeRequest {
	readonly method?: string;
	readonly path: string;
	readonly headers?: Record<string, string>;
	readonly body?: unknown;
}

const [file] = Bun.argv.slice(2);
if (!file) throw new Error("Usage: bun scripts/smoke-app.ts <app.ts>");
const requests = JSON.parse(await Bun.stdin.text()) as SmokeRequest[];
const module = await import(resolve(file));
const app = [module.default, module.app].find(
	(candidate) => typeof candidate?.fetch === "function",
);
if (!app) throw new Error("app.ts exports no app with a fetch method.");

const answers: unknown[] = [];
for (const request of requests) {
	const headers: Record<string, string> = { ...(request.headers ?? {}) };
	const init: RequestInit = { method: request.method ?? "GET", headers };
	if (request.body !== undefined) {
		headers["content-type"] ??= "application/json";
		init.body =
			typeof request.body === "string"
				? request.body
				: JSON.stringify(request.body);
	}
	try {
		const response: Response = await app.fetch(
			new Request(`http://localhost${request.path}`, init),
		);
		answers.push({
			request: `${init.method} ${request.path}`,
			status: response.status,
			contentType: response.headers.get("content-type"),
			body: (await response.text()).slice(0, 2_000),
		});
	} catch (error) {
		answers.push({
			request: `${init.method} ${request.path}`,
			threw: error instanceof Error ? error.message : String(error),
		});
	}
}
console.log(JSON.stringify(answers, null, 2));
process.exit(0);
