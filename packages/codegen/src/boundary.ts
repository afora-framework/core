import { existsSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { issue } from "./scope";
import type { SpecIssue } from "./spec/types";

const DEFAULT_OUTPUT_DIR = "src/domain";

/** Whether `path` is `root` or inside it. */
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	);
}

/** The real path of the deepest part of `path` that exists, with the rest appended. */
function realWithin(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
		existing = parent;
	}
	try {
		return resolve(realpathSync(existing), ...rest);
	} catch {
		return path;
	}
}

/** The directories a generated file never goes in: dependencies and version control. */
const TOOLING_DIRS = new Set(["node_modules", ".git"]);

/**
 * Why a module cannot be trusted to mean what `path.resolve` says it means.
 * A runtime resolves a relative module as a URL, where a backslash is a `/`
 * and `%2e%2e` is `..`, so `./a\\..\\..\\x` leaves the directory whatever
 * `resolve` says on POSIX; control characters have no place in a module.
 */
function specifierProblem(module: string): string | undefined {
	if (module.includes("\\")) return "has a backslash";
	if (module.includes("%")) return "has a percent-encoded character";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\u0000-\u001f\u007f]/.test(module)) return "has a control character";
	return undefined;
}

/**
 * Why a package specifier cannot be trusted to stay a package: a `.` or `..`
 * segment (`pkg/../../x` resolves from `node_modules/pkg` to anywhere), an
 * empty segment, or a module built into the runtime (`fs`, `child_process`,
 * `bun`), which is not a package of the project.
 */
function packageProblem(module: string): string | undefined {
	if (
		module
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		return 'has an empty, "." or ".." segment, so it can resolve outside the package';
	}
	if (isBuiltin(module) || module === "bun" || module.startsWith("bun/")) {
		return "is a module built into the runtime";
	}
	return undefined;
}

/** A module that is a file path, not a package: relative, absolute or a URL. */
function isPathModule(module: string): boolean {
	return (
		module.startsWith(".") ||
		module.startsWith("/") ||
		module.startsWith("\\") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(module)
	);
}

/**
 * The places where `spec` reaches outside the project directory `root`: an
 * `{ "import": "<module>#<name>" }` whose module is a file outside it (the
 * functions of `run` steps, hand-written use cases, hooks, stages, providers,
 * handlers), and an `extends` that names a spec file outside it. A relative
 * module resolves from the output directory, as the generated code imports
 * it; a package name is left to the dependencies of the project. Absolute
 * paths and URLs are refused whatever they point to.
 *
 * `validateSpec` does not run this: a spec has no directory of its own. A
 * tool that takes a spec from someone it does not trust (an agent) runs it
 * with the directory it is allowed to write in.
 */
export function projectBoundaryIssues(
	spec: unknown,
	root: string,
): SpecIssue[] {
	const issues: SpecIssue[] = [];
	if (typeof spec !== "object" || spec === null) return issues;
	const base = resolve(root);
	const realBase = realWithin(base);
	const given = (spec as { output?: { dir?: unknown } }).output?.dir;
	const outputDir = resolve(
		base,
		typeof given === "string" ? given : DEFAULT_OUTPUT_DIR,
	);

	const check = (
		module: string,
		from: string,
		path: readonly (string | number)[],
		what: string,
	) => {
		const problem =
			specifierProblem(module) ??
			(isPathModule(module) ? undefined : packageProblem(module));
		if (problem) {
			issues.push(
				issue(
					path,
					"outside_project",
					`${what} "${module}" ${problem}; use a path relative to the project, inside it, or a package of the project.`,
				),
			);
			return;
		}
		if (!isPathModule(module)) return;
		if (!module.startsWith(".")) {
			issues.push(
				issue(
					path,
					"outside_project",
					`${what} "${module}" is an absolute path or a URL; use a path relative to the project, inside it, or a package.`,
				),
			);
			return;
		}
		const target = resolve(from, module);
		if (!inside(base, target)) {
			issues.push(
				issue(
					path,
					"outside_project",
					`${what} "${module}" is outside the project directory.`,
				),
			);
		} else if (!inside(realBase, realWithin(target))) {
			issues.push(
				issue(
					path,
					"outside_project",
					`${what} "${module}" goes through a symbolic link that leaves the project directory.`,
				),
			);
		}
	};

	// An output.dir that climbs out (`..`, absolute) is `invalid_output` of
	// validateSpec; what only the disk or the project's layout tells is here.
	if (typeof given === "string" && inside(base, outputDir)) {
		const tooling = given.split(/[\\/]/).some((part) => TOOLING_DIRS.has(part));
		if (tooling || !inside(realBase, realWithin(outputDir))) {
			issues.push(
				issue(
					["output", "dir"],
					"outside_project",
					tooling
						? `The output directory "${given}" is inside node_modules or .git; generate into a directory of your sources.`
						: `The output directory "${given}" goes through a symbolic link that leaves the project directory.`,
				),
			);
		}
	}

	const references = (spec as { extends?: unknown }).extends;
	if (Array.isArray(references)) {
		for (const [index, reference] of references.entries()) {
			if (typeof reference === "string") {
				check(reference, base, ["extends", index], "The extended spec");
			}
		}
	}

	const seen = new Set<object>();
	const walk = (value: unknown, path: readonly (string | number)[]): void => {
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) walk(item, [...path, index]);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.import === "string") {
			const at = record.import.lastIndexOf("#");
			check(
				at > 0 ? record.import.slice(0, at) : record.import,
				outputDir,
				[...path, "import"],
				"The imported module",
			);
		}
		for (const [key, item] of Object.entries(record))
			walk(item, [...path, key]);
	};
	walk(spec, []);
	return issues;
}
