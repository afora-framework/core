import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GeneratedFile } from "../src/generate";

const ROOT = resolve(import.meta.dir, "../../..");
const SCRATCH = resolve(import.meta.dir, ".tmp");

/** Writes `files` to a fresh project under tests/.tmp, with a tsconfig that resolves `@afora/core` to its source. */
export async function makeProject(
	files: readonly GeneratedFile[],
	extra: Readonly<Record<string, string>> = {},
	include: readonly string[] = ["src"],
): Promise<string> {
	await mkdir(SCRATCH, { recursive: true });
	const dir = await mkdtemp(join(SCRATCH, "project-"));
	const tsconfig = {
		compilerOptions: {
			target: "ESNext",
			module: "Preserve",
			moduleResolution: "bundler",
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			verbatimModuleSyntax: true,
			types: [],
			paths: { "@afora/core": [join(ROOT, "src/index.ts")] },
		},
		include,
	};
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify(tsconfig, null, 2),
	);
	for (const file of files) {
		await mkdir(dirname(join(dir, file.path)), { recursive: true });
		await writeFile(join(dir, file.path), file.contents);
	}
	for (const [path, contents] of Object.entries(extra)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), contents);
	}
	return dir;
}

export const removeProject = (dir: string) =>
	rm(dir, { recursive: true, force: true });

/** Runs a command; gives its output and exit code. */
export async function run(cwd: string, ...command: string[]) {
	const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, output: `${stdout}${stderr}` };
}

export const BIOME = join(ROOT, "node_modules/.bin/biome");
