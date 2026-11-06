#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { createProject, projectInfo } from "./project";
import { execute } from "./runner";
import { sandboxStore } from "./sandbox";
import { languageQueue, stale } from "./scheduler";

const args = process.argv.slice(2).filter((arg) => arg !== "playground");
if (args.includes("--help")) {
	console.log(
		"afora playground [--project /path/to/project] [--port 4317]\n\nLocal TypeScript editor using the project's package.json, tsconfig and installed dependencies. Requires Bun.\nDevelopment only: --source uses this repository's src/index.ts.",
	);
	process.exit(0);
}
const option = (name: string, fallback: string) => {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`Missing value for ${name}`);
	return value;
};
const project = resolve(option("--project", process.cwd()));
const port = Number(option("--port", "4317"));
if (!Number.isInteger(port) || port < 1 || port > 65535)
	throw new Error("Invalid port");
if (!(await Bun.file(join(project, "package.json")).exists()))
	throw new Error(`No package.json in ${project}`);
const source = args.includes("--source");
if (source && !(await Bun.file(join(project, "src/index.ts")).exists()))
	throw new Error("Source mode requires src/index.ts");
const sandboxes = sandboxStore(project);
const assets = join(import.meta.dir, "assets");
const sessions = new Map<
	string,
	{
		project: ReturnType<typeof createProject>;
		queue: ReturnType<typeof languageQueue>;
	}
>();
const executions = new Set<AbortController>();
const getProject = (id: string) => {
	let context = sessions.get(id);
	if (!context) {
		if (sessions.size >= 8) {
			const oldest = sessions.keys().next().value;
			if (oldest) {
				sessions.get(oldest)?.project.dispose();
				sessions.delete(oldest);
			}
		}
		context = {
			project: createProject(project, source),
			queue: languageQueue(),
		};
		sessions.set(id, context);
	}
	return context;
};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	idleTimeout: 30,
	maxRequestBodySize: 512 * 1024,
	async fetch(request) {
		const url = new URL(request.url);
		// Reject cross-origin access and DNS rebinding to a local code runner.
		if (
			request.headers.get("host") !== `127.0.0.1:${port}` &&
			request.headers.get("host") !== `localhost:${port}`
		)
			return new Response("Invalid host", { status: 403 });
		const origin = request.headers.get("origin");
		if (origin && origin !== url.origin)
			return new Response("Invalid origin", { status: 403 });
		if (
			request.method === "POST" &&
			request.headers.get("x-afora-playground") !== "1"
		)
			return new Response("Missing playground header", { status: 403 });
		try {
			if (url.pathname === "/api/sandbox" && request.method === "GET")
				return Response.json(await sandboxes.list(), {
					headers: { "Cache-Control": "no-store" },
				});
			if (url.pathname === "/api/sandbox" && request.method === "POST") {
				const body = await request.json();
				return Response.json(
					await sandboxes.save(body.name, body.code, body.id),
				);
			}
			if (url.pathname === "/api/sandbox/delete" && request.method === "POST") {
				const body = await request.json();
				await sandboxes.remove(body.id);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/project" && request.method === "GET")
				return Response.json({ ...(await projectInfo(project)), source });
			if (url.pathname === "/api/refresh" && request.method === "POST") {
				for (const context of sessions.values()) context.project.reload();
				return Response.json({ ...(await projectInfo(project)), source });
			}
			if (url.pathname === "/api/language" && request.method === "POST") {
				const body = await request.json();
				if (
					typeof body.code !== "string" ||
					typeof body.session !== "string" ||
					body.session.length > 100 ||
					typeof body.action !== "string"
				)
					return new Response("Invalid request", { status: 400 });
				const context = getProject(body.session);
				const result = await context.queue.run(
					() =>
						context.project.query(
							body.code,
							body.action,
							Number(body.position) || 0,
							body.name,
							body.source,
						),
					{
						version: Number.isInteger(body.version) ? body.version : undefined,
						interactive: body.action !== "diagnostics",
						signal: request.signal,
					},
				);
				// Superseded by a newer buffer version or aborted by the client.
				if (result === stale) return new Response(null, { status: 204 });
				return Response.json(result);
			}
			if (url.pathname === "/api/run" && request.method === "POST") {
				if (executions.size >= 4)
					return new Response(
						"Há quatro execuções ativas. Aguarde uma terminar.",
						{ status: 429 },
					);
				const body = await request.json();
				if (typeof body.code !== "string")
					return new Response("Invalid code", { status: 400 });
				const controller = new AbortController();
				executions.add(controller);
				const abort = () => controller.abort();
				request.signal.addEventListener("abort", abort, { once: true });
				let closed = false;
				const stream = new ReadableStream({
					start(streamController) {
						const emit = (event: unknown) => {
							if (!closed)
								streamController.enqueue(
									new TextEncoder().encode(`${JSON.stringify(event)}\n`),
								);
						};
						void execute(body.code, project, source, emit, controller.signal)
							.catch((error) =>
								emit({ type: "log", level: "error", values: [String(error)] }),
							)
							.finally(() => {
								if (!closed) {
									closed = true;
									streamController.close();
								}
								request.signal.removeEventListener("abort", abort);
								executions.delete(controller);
							});
					},
					cancel() {
						closed = true;
						controller.abort();
					},
				});
				return new Response(stream, {
					headers: {
						"Content-Type": "application/x-ndjson",
						"Cache-Control": "no-store",
					},
				});
			}
			if (request.method !== "GET")
				return new Response("Not found", { status: 404 });
			const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
			if (!/^[a-zA-Z0-9._-]+$/.test(name))
				return new Response("Not found", { status: 404 });
			const file = Bun.file(join(assets, name));
			return (await file.exists())
				? new Response(file, {
						headers: {
							"Cache-Control": "no-cache",
							"X-Content-Type-Options": "nosniff",
						},
					})
				: new Response("Not found", { status: 404 });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	},
});
console.log(
	`\nafora playground → ${server.url}\nProjeto: ${project}\nBiblioteca: ${source ? "src/ (desenvolvimento)" : "dependências instaladas"}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		for (const execution of executions) execution.abort();
		server.stop(true);
		process.exit(0);
	});
