import { posix } from "node:path";
import { isImportObject, parseImportRef } from "./provider";
import type { Decl, Scope } from "./scope";
import { isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";
import { isGeneric, isImported } from "./use-case";

/** The suffix of the file of a use case that hand-written code imports. */
export const USE_CASE_FILE_SUFFIX = ".use-case.ts";

/** The file of a use case kept out of `use-cases.ts`: `RegisterUser` -> `register-user.use-case.ts`. */
function useCaseFileOf(name: string): string {
	const kebab = name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	return `${kebab}${USE_CASE_FILE_SUFFIX}`;
}

/** The names of the use cases a use case declaration depends on (its own or a standard one's options). */
function dependencyNames(decl: Decl): string[] {
	const { spec } = decl;
	const named = isGeneric(spec)
		? (spec.options as { dependencies?: unknown } | undefined)?.dependencies
		: spec.dependencies;
	if (!isObject(named)) return [];
	return Object.values(named).filter(
		(value): value is string => typeof value === "string",
	);
}

/** A module of an import reference, without its extension, to compare two. */
function moduleKey(module: string): string {
	return posix.normalize(module).replace(/\.(m?[jt]sx?)$/, "");
}

/** The module of the hand-written class of an imported use case. */
function handlerModule(decl: Decl): string | undefined {
	const ref = parseImportRef(
		(decl.spec.implementation as { import?: unknown } | undefined)?.import,
	);
	return ref ? moduleKey(ref.module) : undefined;
}

/** The modules of the hand-written functions a generated use case imports (`run` steps, `before`/`after`). */
function functionModules(decl: Decl): string[] {
	const found: string[] = [];
	const add = (value: unknown): void => {
		if (isObject(value) && isImportObject(value)) {
			const ref = parseImportRef(value.import);
			if (ref) found.push(moduleKey(ref.module));
		}
	};
	const options = decl.spec.options as Record<string, unknown> | undefined;
	add(options?.before);
	add(options?.after);
	const steps = (decl.spec.implementation as { steps?: unknown } | undefined)
		?.steps;
	if (Array.isArray(steps)) {
		for (const step of steps) if (isObject(step)) add(step.fn);
	}
	return found;
}

/** Whether `decl` is a use case of this spec (not inherited). */
const ownUseCase = (decl: Decl | undefined): decl is Decl =>
	decl?.kind === "useCase" && decl.via === undefined;

/**
 * The use cases that get a file of their own instead of `use-cases.ts`, by
 * name: every imported one (its `<Name>Base`, which the hand-written class
 * extends), and every generated one such a class needs, through its
 * dependencies or those of the generated use cases it needs. None of these
 * files imports `use-cases.ts`, so `use-cases.ts` can import the hand-written
 * classes a generated use case depends on without a cycle.
 */
export function useCaseFiles(
	own: readonly Decl[],
	scope: Scope,
): Map<string, string> {
	const files = new Map<string, string>();
	const visit = (decl: Decl): void => {
		if (files.has(decl.name)) return;
		files.set(decl.name, useCaseFileOf(decl.name));
		for (const name of dependencyNames(decl)) {
			const target = scope.decls.get(name);
			if (ownUseCase(target)) visit(target);
		}
	};
	for (const decl of own) {
		if (decl.kind === "useCase" && isImported(decl.spec)) visit(decl);
	}
	return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The problems of the files of `useCaseFiles`: two use cases whose files
 * would have the same name (`file_collision`), and a cycle of imports between
 * them and the hand-written modules (`import_cycle`), which only a module
 * shared by several hand-written classes or functions can make, since the
 * use cases themselves cannot depend on each other in a loop.
 */
export function useCaseFileIssues(
	own: readonly Decl[],
	scope: Scope,
): SpecIssue[] {
	const issues: SpecIssue[] = [];
	const files = useCaseFiles(own, scope);
	const byFile = new Map<string, string>();
	for (const [name, file] of files) {
		const seen = byFile.get(file.toLowerCase());
		if (seen !== undefined) {
			issues.push({
				path: ["useCases", name],
				code: "file_collision",
				message: `"${name}" and "${seen}" would both be generated as ${file} (a hand-written class needs them, so each has a file of its own). Rename one of them.`,
			});
		} else byFile.set(file.toLowerCase(), name);
	}

	// The graph of imports: a use case file -> the files and modules it imports,
	// a hand-written module -> the files of the classes it extends.
	const edges = new Map<string, Set<string>>();
	const edge = (from: string, to: string): void => {
		const set = edges.get(from) ?? new Set<string>();
		set.add(to);
		edges.set(from, set);
	};
	const handlerModules = new Set<string>();
	for (const name of files.keys()) {
		const decl = scope.decls.get(name) as Decl;
		if (isImported(decl.spec)) {
			const module = handlerModule(decl);
			if (module === undefined) continue;
			handlerModules.add(module);
			edge(`module ${module}`, `use case ${name}`);
		}
	}
	for (const name of files.keys()) {
		const decl = scope.decls.get(name) as Decl;
		if (!isImported(decl.spec)) {
			for (const module of functionModules(decl)) {
				if (handlerModules.has(module)) {
					edge(`use case ${name}`, `module ${module}`);
				}
			}
		}
		for (const dep of dependencyNames(decl)) {
			const target = scope.decls.get(dep);
			if (!ownUseCase(target)) continue;
			if (isImported(target.spec)) {
				const module = handlerModule(target);
				if (module !== undefined) edge(`use case ${name}`, `module ${module}`);
			} else edge(`use case ${name}`, `use case ${dep}`);
		}
	}

	const state = new Map<string, "open" | "done">();
	const stack: string[] = [];
	let found: string[] | undefined;
	const walk = (node: string): void => {
		state.set(node, "open");
		stack.push(node);
		for (const next of [...(edges.get(node) ?? [])].sort()) {
			if (found) break;
			if (state.get(next) === "open") {
				found = [...stack.slice(stack.indexOf(next)), next];
			} else if (!state.has(next)) walk(next);
		}
		stack.pop();
		state.set(node, "done");
	};
	for (const node of [...edges.keys()].sort()) {
		if (found) break;
		if (!state.has(node)) walk(node);
	}
	// A loop through use cases alone is a `cycle` of declarations, reported apart.
	if (found?.some((node) => node.startsWith("module "))) {
		const first = found.find((node) => node.startsWith("use case ")) as string;
		const name = first.slice("use case ".length);
		const decl = scope.decls.get(name) as Decl;
		issues.push({
			path: isImported(decl.spec)
				? ["useCases", name, "implementation"]
				: ["useCases", name],
			code: "import_cycle",
			message: `The generated files would import each other in a loop: ${found.join(" -> ")}. A hand-written module that holds several classes or functions joins them; move the class or function to a module of its own.`,
		});
	}
	return issues;
}
