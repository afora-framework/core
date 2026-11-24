import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { boundaryIssues, isInside, specFileOf } from "./boundary";
import type { ResolvedSpec, Spec } from "./spec/types";

/** Thrown when a spec file cannot be read, parsed, or one it extends cannot be found. */
export class SpecLoadError extends Error {
	override readonly name = "SpecLoadError";
}

/** A spec read from disk, with the specs it extends (recursively), by the reference it uses. */
export interface LoadedSpec {
	readonly spec: Spec;
	readonly path: string;
	readonly extended: Readonly<Record<string, ResolvedSpec>>;
}

/** Reads `path` as JSON; its errors name it `shown` (the path by default). */
async function read(path: string, shown = path): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new SpecLoadError(
			`Cannot read ${shown}: ${reason.split(path).join(shown)}`,
		);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		// Never the engine's message: it can quote the text of the file.
		throw new SpecLoadError(
			`${shown} is not valid JSON${positionOf(text, error)}.`,
		);
	}
}

/**
 * ` (line L, column C)` of a JSON.parse error, when the engine gives the
 * offset (Node does, as `position N`); only that number is read from its message.
 */
function positionOf(text: string, error: unknown): string {
	const match = /\bposition (\d+)\b/.exec(
		error instanceof Error ? error.message : "",
	);
	if (!match) return "";
	const offset = Math.min(Number(match[1]), text.length);
	const before = text.slice(0, offset);
	const line = before.split("\n").length;
	const column = offset - before.lastIndexOf("\n");
	return ` (line ${line}, column ${column})`;
}

/** The file a reference points to: a relative path (a directory means its afora.json) or a package. */
export function referenceToPath(ref: string, from: string): string {
	if (ref.startsWith(".") || isAbsolute(ref)) {
		return specFileOf(resolve(dirname(from), ref));
	}
	try {
		return createRequire(from).resolve(`${ref}/afora.json`);
	} catch {
		throw new SpecLoadError(
			`Cannot find the package "${ref}" (or its afora.json) from ${dirname(from)}. It must export "./afora.json".`,
		);
	}
}

/** The name of a package specifier (`pkg`, `@scope/pkg`) and the rest of it. */
function packageParts(
	ref: string,
): { name: string; subpath: string } | undefined {
	const parts = ref.split("/");
	const size = ref.startsWith("@") ? 2 : 1;
	if (
		parts.length < size ||
		parts.some(
			(part) =>
				part === "" ||
				part === "." ||
				part === ".." ||
				part.includes("\\") ||
				part.toLowerCase() === "node_modules",
		)
	) {
		return undefined;
	}
	return {
		name: parts.slice(0, size).join("/"),
		subpath: parts.slice(size).join("/"),
	};
}

/** The file an `exports` target names in `dir`: a `./` path, the first of an array, a condition. */
function exportTarget(
	dir: string,
	target: unknown,
	depth = 0,
): string | undefined {
	if (depth > 8) return undefined;
	if (typeof target === "string") {
		if (!target.startsWith("./")) return undefined;
		const segments = target.slice(2).split(/[\\/]/);
		if (segments.some((s) => s === "." || s === ".." || s === "node_modules")) {
			return undefined;
		}
		return resolve(dir, target);
	}
	if (Array.isArray(target)) {
		for (const item of target) {
			const file = exportTarget(dir, item, depth + 1);
			if (file !== undefined) return file;
		}
		return undefined;
	}
	if (typeof target === "object" && target !== null) {
		for (const [condition, value] of Object.entries(target)) {
			if (["node", "require", "import", "default"].includes(condition)) {
				return exportTarget(dir, value, depth + 1);
			}
		}
	}
	return undefined;
}

/** The file `subpath` (`./afora.json`, `./x/afora.json`) of the package in `dir`, by its `exports`. */
function exportedFile(
	dir: string,
	manifest: unknown,
	subpath: string,
): string | undefined {
	const exports =
		typeof manifest === "object" && manifest !== null
			? (manifest as { exports?: unknown }).exports
			: undefined;
	if (exports === undefined || exports === null) return resolve(dir, subpath);
	if (
		typeof exports !== "object" ||
		Array.isArray(exports) ||
		!Object.keys(exports).some((key) => key.startsWith("."))
	) {
		// Only "." is exported.
		return undefined;
	}
	const map = exports as Record<string, unknown>;
	if (Object.hasOwn(map, subpath)) return exportTarget(dir, map[subpath]);
	let best: { key: string; star: string } | undefined;
	for (const key of Object.keys(map)) {
		const star = key.indexOf("*");
		if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (
			subpath.length >= key.length - 1 &&
			subpath.startsWith(prefix) &&
			subpath.endsWith(suffix) &&
			(best === undefined || prefix.length > best.key.indexOf("*"))
		) {
			best = {
				key,
				star: subpath.slice(prefix.length, subpath.length - suffix.length),
			};
		}
	}
	if (best === undefined) return undefined;
	const { key, star } = best;
	const replace = (value: unknown): unknown =>
		typeof value === "string"
			? value.split("*").join(star)
			: Array.isArray(value)
				? value.map(replace)
				: typeof value === "object" && value !== null
					? Object.fromEntries(
							Object.entries(value).map(([k, v]) => [k, replace(v)]),
						)
					: value;
	return exportTarget(dir, replace(map[key]));
}

/**
 * The spec file of the package `ref`, looked up as Node would from `from`
 * but only in the `node_modules` of `root` and of its directories under it:
 * never a parent directory of `root`, a global cache or the registry.
 */
async function packageSpecFile(
	ref: string,
	from: string,
	root: string,
): Promise<string | undefined> {
	const parts = packageParts(ref);
	if (parts === undefined) return undefined;
	const subpath = `./${parts.subpath === "" ? "" : `${parts.subpath}/`}afora.json`;
	for (let dir = dirname(from); isInside(root, dir); dir = dirname(dir)) {
		const pkg = join(dir, "node_modules", parts.name);
		let text: string;
		try {
			text = await readFile(join(pkg, "package.json"), "utf8");
		} catch {
			continue;
		}
		let manifest: unknown;
		try {
			manifest = JSON.parse(text);
		} catch {
			return undefined;
		}
		return exportedFile(pkg, manifest, subpath);
	}
	return undefined;
}

function referencesOf(spec: unknown): string[] {
	return typeof spec === "object" &&
		spec !== null &&
		Array.isArray((spec as Spec).extends)
		? ((spec as Spec).extends as unknown[]).filter(
				(ref): ref is string => typeof ref === "string",
			)
		: [];
}

const isPathReference = (ref: string) => ref.startsWith(".") || isAbsolute(ref);

/**
 * Where a spec read with a project root may be: `project` for one reached
 * by a path from the project (inside the root, held to its boundary), and
 * `package` for one reached as a package of the project or by a path from
 * such a spec (inside the `node_modules` of the root, really).
 */
type Scope = "none" | "project" | "package";

class Loader {
	private readonly cache = new Map<string, ResolvedSpec>();
	private readonly loading = new Set<string>();

	/**
	 * With `root`, a spec reached by a path must stay inside it, and so must
	 * what it names; a package is one of `<root>/node_modules` only.
	 */
	constructor(private readonly root?: string) {}

	/** How a message names `file`: from the root when there is one, never by an absolute path. */
	private shown(file: string): string {
		if (this.root === undefined) return file;
		return isInside(this.root, file)
			? relative(this.root, file) || "."
			: "a file outside the project";
	}

	async extended(
		spec: unknown,
		file: string,
		scope: Scope = this.root === undefined ? "none" : "project",
	): Promise<Record<string, ResolvedSpec>> {
		const extended: Record<string, ResolvedSpec> = {};
		for (const ref of referencesOf(spec)) {
			if (this.root === undefined || scope === "none") {
				extended[ref] = await this.load(referenceToPath(ref, file), "none");
			} else if (isPathReference(ref)) {
				// A path from a package stays in the packages of the project.
				extended[ref] = await this.load(
					specFileOf(resolve(dirname(file), ref)),
					scope,
				);
			} else {
				// A package is a dependency of the project: one it installed.
				const found = await packageSpecFile(ref, file, this.root);
				if (found === undefined) {
					throw new SpecLoadError(
						`Cannot find the package "${ref}" (or its afora.json) in the node_modules of the project. It must export "./afora.json".`,
					);
				}
				extended[ref] = await this.load(found, "package", ref);
			}
		}
		return extended;
	}

	/**
	 * A file is read only where it really is inside the root (`project`), or
	 * inside `<root>/node_modules` (`package`).
	 */
	private async confine(
		file: string,
		scope: Scope,
		ref?: string,
	): Promise<void> {
		const root = this.root as string;
		const within = await realpath(
			scope === "package" ? join(root, "node_modules") : root,
		).catch(() => undefined);
		const real = await realpath(file).catch(() => undefined);
		// A file that does not exist fails as one when it is read.
		if (real === undefined) return;
		if (within === undefined || !isInside(within, real)) {
			throw new SpecLoadError(
				scope === "package"
					? `${ref === undefined ? this.shown(file) : `The package "${ref}"`} is outside the node_modules of the project: a package spec, and what it extends, must be installed in it.`
					: `${this.shown(file)} reaches outside the project: it is a symbolic link, or under one, that leaves the project directory.`,
			);
		}
	}

	async load(
		file: string,
		scope: Scope = "none",
		ref?: string,
	): Promise<ResolvedSpec> {
		const cached = this.cache.get(file);
		if (cached) return cached;
		const shown = this.shown(file);
		if (this.loading.has(file)) {
			throw new SpecLoadError(
				`${shown} extends itself (a cycle of "extends").`,
			);
		}
		this.loading.add(file);
		const confined = scope !== "none" && this.root !== undefined;
		if (confined) await this.confine(file, scope, ref);
		const spec = (await read(file, shown)) as Spec;
		if (scope === "project" && this.root !== undefined) {
			const issues = boundaryIssues(spec, this.root, dirname(file));
			if (issues.length > 0) {
				throw new SpecLoadError(
					`${shown} reaches outside the project: ${issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join(" ")}`,
				);
			}
		}
		const extended = await this.extended(spec, file, scope);
		this.loading.delete(file);
		const resolved: ResolvedSpec = { spec, extends: extended };
		this.cache.set(file, resolved);
		return resolved;
	}
}

/**
 * Reads an `afora.json` and the specs it extends, recursively. A spec reached
 * twice is the same object, so `validateSpec` and `generate` dedupe it.
 */
export async function loadSpec(path: string): Promise<LoadedSpec> {
	const absolute = resolve(path);
	const root = await new Loader().load(absolute);
	return { spec: root.spec, path: absolute, extended: root.extends ?? {} };
}

/**
 * The specs that `spec` extends, loaded as `loadSpec` would if `spec` were
 * the file `file` (its references resolve from there). With `root`, a spec
 * reached by a path, at any depth, must pass `projectBoundaryIssues` from
 * its own directory (its `extends`, `imports` and `output.dir` stay inside
 * `root`), or `SpecLoadError` is thrown before what it extends is read. A
 * package is looked up only in the `node_modules` of `root` (and of its
 * directories, as Node would, but never above `root`, in a global cache or
 * the registry), and its spec, with what that extends, must really be inside
 * `<root>/node_modules`; its `imports` are its own and are not checked. The
 * messages name a file from `root`, never by an absolute path.
 */
export function resolveExtended(
	spec: unknown,
	file: string,
	options: { readonly root?: string } = {},
): Promise<Record<string, ResolvedSpec>> {
	const root = options.root === undefined ? undefined : resolve(options.root);
	return new Loader(root).extended(spec, resolve(file));
}
