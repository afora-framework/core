import { isAbsolute, relative, resolve, sep } from "node:path";
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
		if (!inside(base, resolve(from, module))) {
			issues.push(
				issue(
					path,
					"outside_project",
					`${what} "${module}" is outside the project directory.`,
				),
			);
		}
	};

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
