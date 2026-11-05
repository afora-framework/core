import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RunEvent = { type: string; [key: string]: unknown };

export async function execute(
	code: string,
	project: string,
	source: boolean,
	emit: (event: RunEvent) => void,
	signal?: AbortSignal,
	timeoutMs = 10000,
) {
	const folder = await mkdtemp(join(tmpdir(), "afora-playground-"));
	const entry = join(folder, "experiment.ts");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let reason: string | undefined;
	let bytes = 0;
	const started = performance.now();
	const stop = () => {
		reason ??= "cancelled";
		child?.kill("SIGKILL");
	};
	const send = (event: RunEvent) => {
		if (reason === "output-limit") return;
		bytes += JSON.stringify(event).length;
		if (bytes > 1_000_000) {
			reason = "output-limit";
			child?.kill("SIGKILL");
			return;
		}
		emit(event);
	};
	try {
		await Bun.write(entry, code);
		if (signal?.aborted) return;
		const built = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			outdir: folder,
			naming: "experiment.js",
			sourcemap: "inline",
			plugins: [
				{
					name: "project-imports",
					setup(build) {
						build.onResolve({ filter: /.*/ }, (args) => {
							if (!args.importer || args.path === entry) return { path: entry };
							if (source && args.path === "@afora/core")
								return { path: join(project, "src/index.ts"), external: true };
							if (
								args.path.startsWith("node:") ||
								builtinModules.includes(args.path)
							)
								return;
							return {
								path: Bun.resolveSync(args.path, project),
								external: true,
							};
						});
					},
				},
			],
		});
		if (!built.success) {
			for (const error of built.logs)
				emit({ type: "log", level: "error", values: [error.message] });
			emit({
				type: "done",
				exitCode: 1,
				duration: Math.round(performance.now() - started),
			});
			return;
		}
		if (signal?.aborted) return;
		const childPath = join(
			import.meta.dir,
			import.meta.path.endsWith(".ts") ? "child.ts" : "child.js",
		);
		const tsconfig = join(project, "tsconfig.json");
		const args = (await Bun.file(tsconfig).exists())
			? ["--tsconfig-override", tsconfig]
			: [];
		child = Bun.spawn(
			[process.execPath, ...args, childPath, join(folder, "experiment.js")],
			{
				cwd: project,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				ipc: (message) => send(message as RunEvent),
			},
		);
		signal?.addEventListener("abort", stop, { once: true });
		timer = setTimeout(() => {
			reason = "timeout";
			child?.kill("SIGKILL");
		}, timeoutMs);
		const pump = async (stream: ReadableStream<Uint8Array>, level: string) => {
			const decoder = new TextDecoder();
			for await (const chunk of stream)
				send({
					type: "log",
					level,
					values: [decoder.decode(chunk, { stream: true })],
				});
			const tail = decoder.decode();
			if (tail) send({ type: "log", level, values: [tail] });
		};
		await Promise.all([
			pump(child.stdout as ReadableStream<Uint8Array>, "log"),
			pump(child.stderr as ReadableStream<Uint8Array>, "error"),
			child.exited,
		]);
		emit({
			type: "done",
			exitCode: child.exitCode,
			reason,
			duration: Math.round(performance.now() - started),
		});
	} catch (error) {
		child?.kill("SIGKILL");
		emit({ type: "log", level: "error", values: [String(error)] });
		emit({
			type: "done",
			exitCode: 1,
			duration: Math.round(performance.now() - started),
		});
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
		await rm(folder, { recursive: true, force: true });
	}
}
