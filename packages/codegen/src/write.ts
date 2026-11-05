import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { BANNER, GENERATED_FILES, type GeneratedFile } from "./generate";

/** A file `writeGenerated` would not touch, and why. */
export interface RefusedFile {
	readonly path: string;
	readonly reason: string;
}

export interface WriteResult {
	readonly written: readonly string[];
	readonly unchanged: readonly string[];
	/** Generated files of an earlier run that the spec no longer produces. */
	readonly removed: readonly string[];
	/** When not empty, nothing was written. */
	readonly refused: readonly RefusedFile[];
}

export interface WriteOptions {
	/** Compute the result without touching the disk. */
	readonly dryRun?: boolean;
}

const exists = (path: string) =>
	lstat(path).then(
		(stats) => stats,
		() => undefined,
	);

/** Whether `path` is `root` or inside it. */
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
	);
}

/** The real path of the deepest part of `path` that exists, with the rest appended. */
async function realWithin(path: string): Promise<string> {
	let existing = path;
	const rest: string[] = [];
	while (!(await exists(existing))) {
		rest.unshift(existing.slice(dirname(existing).length + 1));
		const parent = dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return resolve(await realpath(existing), ...rest);
}

/**
 * Where `path` is under `root`, if it is safe to write there: inside the
 * directory (no `..`, not absolute outside it), not through a symlink that
 * leaves it, and not a symlink itself.
 */
export async function confinePath(
	root: string,
	path: string,
): Promise<
	| { readonly ok: true; readonly absolute: string }
	| { readonly ok: false; readonly reason: string }
> {
	const base = resolve(root);
	const realBase = await realpath(base);
	const absolute = resolve(base, path);
	if (!inside(base, absolute)) {
		return { ok: false, reason: "outside the project directory" };
	}
	if (!inside(realBase, await realWithin(absolute))) {
		return { ok: false, reason: "resolves outside the project (symlink)" };
	}
	if ((await exists(absolute))?.isSymbolicLink()) {
		return { ok: false, reason: "is a symbolic link" };
	}
	return { ok: true, absolute };
}

/** Whether `text` starts with the banner of generated files. */
export function isGenerated(text: string): boolean {
	return text.split(/\r?\n/, 1)[0] === BANNER;
}

/**
 * Writes `files` under `root` (a project directory), and removes the
 * generated files of the same directory that `files` no longer has. It only
 * touches paths inside `root` (no `..`, no symlink out of it) and only
 * overwrites or removes files that carry the banner; if any file is refused
 * it writes nothing.
 */
export async function writeGenerated(
	root: string,
	files: readonly GeneratedFile[],
	options: WriteOptions = {},
): Promise<WriteResult> {
	const refused: RefusedFile[] = [];
	const plan: { file: GeneratedFile; absolute: string; same: boolean }[] = [];
	const check = async (
		path: string,
		report = true,
	): Promise<string | undefined> => {
		const confined = await confinePath(root, path);
		if (confined.ok) return confined.absolute;
		if (report) refused.push({ path, reason: confined.reason });
		return undefined;
	};

	for (const file of files) {
		const absolute = await check(file.path);
		if (!absolute) continue;
		const stats = await exists(absolute);
		let same = false;
		if (stats) {
			if (!stats.isFile()) {
				refused.push({ path: file.path, reason: "is not a regular file" });
				continue;
			}
			const current = await readFile(absolute, "utf8");
			if (!isGenerated(current)) {
				refused.push({
					path: file.path,
					reason: `exists and does not start with the generated banner ("${BANNER}"); it is not overwritten`,
				});
				continue;
			}
			same = current === file.contents;
		}
		plan.push({ file, absolute, same });
	}

	const orphans: { path: string; absolute: string }[] = [];
	const dirs = new Set(files.map((file) => dirname(file.path)));
	const kept = new Set(files.map((file) => file.path));
	for (const dir of dirs) {
		for (const name of GENERATED_FILES) {
			const path = dir === "." ? name : `${dir}/${name}`;
			if (kept.has(path)) continue;
			const absolute = await check(path, false);
			if (!absolute) continue;
			const stats = await exists(absolute);
			if (!stats?.isFile()) continue;
			if (isGenerated(await readFile(absolute, "utf8"))) {
				orphans.push({ path, absolute });
			}
		}
	}

	if (refused.length > 0) {
		return { written: [], unchanged: [], removed: [], refused };
	}
	const written = plan.filter((entry) => !entry.same).map((e) => e.file.path);
	const unchanged = plan.filter((entry) => entry.same).map((e) => e.file.path);
	if (!options.dryRun) {
		for (const { file, absolute, same } of plan) {
			if (same) continue;
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, file.contents, "utf8");
		}
		for (const { absolute } of orphans) await rm(absolute);
	}
	return {
		written,
		unchanged,
		removed: orphans.map((orphan) => orphan.path),
		refused: [],
	};
}
