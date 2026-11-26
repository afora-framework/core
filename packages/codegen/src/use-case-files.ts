import { posix } from "node:path";
import { cyclesOf, fieldsOfDecl, typesIn } from "./graph";
import { isImportObject, parseImportRef } from "./provider";
import type { Decl, Scope } from "./scope";
import { isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";
import { isGeneric, isImported } from "./use-case";

/** The suffix of the file of a use case that hand-written code imports. */
export const USE_CASE_FILE_SUFFIX = ".use-case.ts";

/** The suffix of the file of an entity a hand-written class needs (its `<Name>Base`, or a generated entity). */
const ENTITY_FILE_SUFFIX = ".entity.ts";

/**
 * The names of the files `generate` can write, in the output directory, besides
 * `<kebab-name>.use-case.ts`: one per use case a hand-written class needs (see `useCaseFiles`).
 */
export const GENERATED_FILES = [
	"properties.ts",
	"blueprints.ts",
	"records.ts",
	"entities.ts",
	"environments.ts",
	"providers.ts",
	"repositories.ts",
	"exceptions.ts",
	"use-cases.ts",
	"commands.ts",
	"outputs.ts",
	"application.ts",
	"index.ts",
] as const;

/**
 * The tables of a catalog provider with `tables` (`schema.ts`, or one file
 * per dialect). Generated only for a spec that stores entities through such
 * a provider, so a hand-written `schema.ts` of another spec stays its own
 * (an import of it is not a `generated_file`).
 */
export const SCHEMA_FILES = [
	"schema.ts",
	"schema.sqlite.ts",
	"schema.pg.ts",
] as const;

/** The file of the tables of `dialect`, among `dialects`, all a provider has. */
export function schemaFileOf(
	dialect: string,
	dialects: readonly string[],
): string {
	if (dialects.length === 1) return "schema.ts";
	return `schema.${dialect === "postgres" ? "pg" : dialect}.ts`;
}

/**
 * `text` with `-` between its words, in one pass: before a capital that
 * follows a small letter or a digit (`changePassword`, `v2Api`), and before
 * the last capital of a run when a small letter follows (`HTTPServer`).
 */
function wordsOf(text: string): string {
	let words = "";
	for (let index = 0; index < text.length; index++) {
		const char = text.charCodeAt(index);
		if (index > 0 && isCapital(char)) {
			const before = text.charCodeAt(index - 1);
			if (
				isSmall(before) ||
				isDigit(before) ||
				(isCapital(before) && isSmall(text.charCodeAt(index + 1)))
			) {
				words += "-";
			}
		}
		words += text[index];
	}
	return words;
}

const isCapital = (char: number) => char >= 65 && char <= 90;
const isSmall = (char: number) => char >= 97 && char <= 122;
const isDigit = (char: number) => char >= 48 && char <= 57;

const kebabOf = (name: string): string =>
	wordsOf(name).replace(/_/g, "-").toLowerCase();

/** The file of a use case kept out of `use-cases.ts`: `RegisterUser` -> `register-user.use-case.ts`. */
export function useCaseFileOf(name: string): string {
	return `${kebabOf(name)}${USE_CASE_FILE_SUFFIX}`;
}

/** The file of an entity kept out of `entities.ts`: `BookingSlot` -> `booking-slot.entity.ts`. */
function entityFileOf(name: string): string {
	return `${kebabOf(name)}${ENTITY_FILE_SUFFIX}`;
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

/** A module path without a trailing `/` or the extension of a script (`.ts`, `.js`, `.mts`...). */
function withoutExtension(module: string): string {
	// `normalize` folds repeated `/`, so at most one trails (kept on `/` alone).
	const normal = posix.normalize(module);
	const trimmed =
		normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
	return trimmed.replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * A module of an import reference, to compare two: normalized, without its
 * extension or a trailing `/index`, so `../handlers/all`, `../handlers/all.js`
 * and `../handlers/all/index.ts` are the same module.
 */
function moduleKey(module: string): string {
	const key = withoutExtension(module);
	if (key === "index") return ".";
	return key.endsWith("/index") ? key.slice(0, -"/index".length) : key;
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
	files: ReadonlyMap<string, string>,
	scope: Scope,
): SpecIssue[] {
	const issues: SpecIssue[] = [];
	const byFile = new Map<string, string>();
	for (const [name, file] of files) {
		const seen = byFile.get(file);
		if (seen !== undefined) {
			issues.push({
				path: ["useCases", name],
				code: "file_collision",
				message: `"${name}" and "${seen}" would both be generated as ${file} (a hand-written class needs them, so each has a file of its own, named in lowercase kebab-case). Rename one of them.`,
			});
		} else byFile.set(file, name);
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

	const [found] = cyclesOf(
		[...edges.keys()].sort(),
		(node) => [...(edges.get(node) ?? [])].sort(),
		true,
	);
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

/** Every module the spec imports, with where: each `{ "import": "<module>#<name>" }` and the `import` of an opaque property. */
function importedModules(
	value: unknown,
	path: readonly (string | number)[],
	found: { path: (string | number)[]; module: string }[],
): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			importedModules(item, [...path, index], found);
		});
		return;
	}
	if (!isObject(value)) return;
	if (typeof value.import === "string") {
		const module =
			parseImportRef(value.import)?.module ??
			(value.opaque === true ? value.import : undefined);
		if (module !== undefined) {
			found.push({
				path: value.opaque === true ? [...path, "import"] : [...path],
				module,
			});
		}
	}
	for (const [key, inner] of Object.entries(value)) {
		importedModules(inner, [...path, key], found);
	}
}

/**
 * An import of the spec (relative to the output directory `dir`) that is a
 * file the generator writes there (`generated_file`): one of
 * `GENERATED_FILES`, or the `<kebab-name>.use-case.ts` or `<kebab-name>.entity.ts` of one of `files`. The
 * generator would overwrite it, so the hand-written code has to live in a file
 * of another name.
 */
export function generatedFileIssues(
	input: Readonly<Record<string, unknown>>,
	files: ReadonlyMap<string, string>,
	dir: string,
): SpecIssue[] {
	const outDir = withoutExtension(dir);
	const generated = new Set<string>([...GENERATED_FILES, ...files.values()]);
	const found: { path: (string | number)[]; module: string }[] = [];
	importedModules(input, [], found);
	const issues: SpecIssue[] = [];
	for (const { path, module } of found) {
		if (!module.startsWith(".")) continue;
		const target = withoutExtension(posix.join(outDir, module));
		const file =
			target === outDir
				? "index.ts"
				: posix.dirname(target) === outDir
					? `${posix.basename(target).toLowerCase()}.ts`
					: undefined;
		if (file === undefined || !generated.has(file)) continue;
		issues.push({
			path,
			code: "generated_file",
			message: `"${module}" is ${posix.join(outDir, file)}, which the generator writes and overwrites, so hand-written code cannot live there. Rename the hand-written file or move it out of the output directory (e.g. "../handlers/..."), and point the import at it.`,
		});
	}
	return issues;
}

// ---------------------------------------------------------------- entities

/** The file each kind of declaration is generated into, before files merge. */
type KindFile =
	| "properties.ts"
	| "blueprints.ts"
	| "records.ts"
	| "entities.ts"
	| "environments.ts"
	| "repositories.ts"
	| "exceptions.ts"
	| "use-cases.ts"
	| "commands.ts"
	| "outputs.ts";

const FILE_OF_KIND: Readonly<Record<Decl["kind"], KindFile>> = {
	property: "properties.ts",
	blueprint: "blueprints.ts",
	record: "records.ts",
	entity: "entities.ts",
	environment: "environments.ts",
	repository: "repositories.ts",
	exception: "exceptions.ts",
	useCase: "use-cases.ts",
	command: "commands.ts",
	output: "outputs.ts",
};

/** Where a file merged into another one goes: the later in this order. */
const MERGE_ORDER: readonly KindFile[] = [
	"blueprints.ts",
	"records.ts",
	"entities.ts",
];

/** Whether `decl` is an entity of this spec with a class written by hand. */
export const isImportedEntity = (decl: Decl | undefined): boolean =>
	decl?.kind === "entity" && decl.via === undefined && isImported(decl.spec);

/** The names a declaration uses: a repository its entity, relations and environments; the others the types of their fields. */
function namesUsedBy(decl: Decl): string[] {
	if (decl.kind === "property") {
		return typeof decl.spec.base === "string" ? [decl.spec.base] : [];
	}
	if (decl.kind === "repository") {
		const list = (value: unknown): string[] =>
			Array.isArray(value)
				? value.filter((item): item is string => typeof item === "string")
				: [];
		return [
			...(typeof decl.spec.entity === "string" ? [decl.spec.entity] : []),
			...list(decl.spec.relations),
			...list(decl.spec.environments),
		];
	}
	const fields = fieldsOfDecl(decl);
	return fields ? typesIn(fields) : [];
}

/**
 * The file each own declaration is generated into: its own file (`files`)
 * when it has one, else the file of its kind, where kinds that need each other
 * share the later file of `MERGE_ORDER`. Declarations with a file of their own
 * do not count for the merges.
 */
export function fileLayoutOf(
	own: readonly Decl[],
	scope: Scope,
	files: ReadonlyMap<string, string>,
): (name: string) => string {
	const home = new Map<KindFile, KindFile>(
		(Object.values(FILE_OF_KIND) as KindFile[]).map((file) => [file, file]),
	);
	const resolveHome = (file: KindFile): KindFile => {
		let current = file;
		while (home.get(current) !== current)
			current = home.get(current) as KindFile;
		return current;
	};
	const shared = own.filter((decl) => !files.has(decl.name));
	const depsFiles = (decl: Decl): KindFile[] =>
		namesUsedBy(decl).flatMap((name) => {
			const dep = scope.decls.get(name);
			return dep && dep.via === undefined && !files.has(dep.name)
				? [FILE_OF_KIND[dep.kind]]
				: [];
		});
	const needs = (from: KindFile, to: KindFile): boolean =>
		shared.some(
			(decl) =>
				resolveHome(FILE_OF_KIND[decl.kind]) === from &&
				depsFiles(decl).some((file) => resolveHome(file) === to),
		);
	let merged = true;
	while (merged) {
		merged = false;
		for (const a of MERGE_ORDER) {
			for (const b of MERGE_ORDER) {
				if (a === b || resolveHome(a) === resolveHome(b)) continue;
				if (
					needs(resolveHome(a), resolveHome(b)) &&
					needs(resolveHome(b), resolveHome(a))
				) {
					const [early, late] =
						MERGE_ORDER.indexOf(resolveHome(a)) <
						MERGE_ORDER.indexOf(resolveHome(b))
							? [resolveHome(a), resolveHome(b)]
							: [resolveHome(b), resolveHome(a)];
					home.set(early, late);
					merged = true;
				}
			}
		}
	}
	return (name: string): string =>
		files.get(name) ??
		resolveHome(FILE_OF_KIND[(scope.decls.get(name) as Decl).kind]);
}

/**
 * The entities that get a file of their own instead of `entities.ts`, by
 * name: every one with a class written by hand (its `<Name>Base`, which the
 * class extends), and every generated entity such a base needs through its
 * fields, at any depth of blueprints and records. None of these files
 * imports `entities.ts`, so `entities.ts` can name a class written by hand.
 */
export function entityFiles(
	own: readonly Decl[],
	scope: Scope,
): Map<string, string> {
	const files = new Map<string, string>();
	const visitFields = (decl: Decl, seen: Set<string>): void => {
		const fields = fieldsOfDecl(decl);
		for (const name of fields ? typesIn(fields) : []) {
			const target = scope.decls.get(name);
			if (target === undefined || target.via !== undefined) continue;
			if (target.kind === "entity") visitEntity(target);
			else if (
				(target.kind === "blueprint" || target.kind === "record") &&
				!seen.has(name)
			) {
				seen.add(name);
				visitFields(target, seen);
			}
		}
	};
	const visitEntity = (decl: Decl): void => {
		if (files.has(decl.name)) return;
		files.set(decl.name, entityFileOf(decl.name));
		visitFields(decl, new Set());
	};
	for (const decl of own) if (isImportedEntity(decl)) visitEntity(decl);
	return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The module of the class written by hand of an entity. */
function entityModule(decl: Decl): string | undefined {
	const ref = parseImportRef(
		(decl.spec.implementation as { import?: unknown } | undefined)?.import,
	);
	return ref ? moduleKey(ref.module) : undefined;
}

/** The modules of the hand-written functions an entity imports: event handlers and upgrade steps. */
function entityFunctionModules(decl: Decl): string[] {
	const found: { path: (string | number)[]; module: string }[] = [];
	importedModules(decl.spec.events, [], found);
	importedModules(decl.spec.upgrade, [], found);
	return found.map(({ module }) => moduleKey(module));
}

/**
 * The problems of the files of `entityFiles`: two entities whose files would
 * have the same name (`file_collision`), and a loop of imports
 * (`import_cycle`) between the files of blueprints, records and entities and
 * the modules of the classes written by hand, as `fileOf` lays them out.
 */
export function entityFileIssues(
	files: ReadonlyMap<string, string>,
	own: readonly Decl[],
	scope: Scope,
	fileOf: (name: string) => string,
): SpecIssue[] {
	const issues: SpecIssue[] = [];
	const byFile = new Map<string, string>();
	for (const [name, file] of files) {
		const seen = byFile.get(file);
		if (seen !== undefined) {
			issues.push({
				path: ["entities", name],
				code: "file_collision",
				message: `"${name}" and "${seen}" would both be generated as ${file} (a class written by hand needs them, so each has a file of its own, named in lowercase kebab-case). Rename one of them.`,
			});
		} else byFile.set(file, name);
	}
	if (issues.length > 0) return issues;

	const edges = new Map<string, Set<string>>();
	const edge = (from: string, to: string): void => {
		if (from === to) return;
		const set = edges.get(from) ?? new Set<string>();
		set.add(to);
		edges.set(from, set);
	};
	// A module of a class written by hand -> the file of the base it extends.
	const modules = new Set<string>();
	for (const decl of own) {
		if (!isImportedEntity(decl)) continue;
		const module = entityModule(decl);
		if (module === undefined) continue;
		modules.add(module);
		edge(`module ${module}`, fileOf(decl.name));
	}
	if (modules.size === 0) return issues;
	for (const decl of own) {
		if (
			decl.kind !== "blueprint" &&
			decl.kind !== "record" &&
			decl.kind !== "entity"
		) {
			continue;
		}
		const from = fileOf(decl.name);
		const fields = fieldsOfDecl(decl);
		for (const name of fields ? typesIn(fields) : []) {
			const target = scope.decls.get(name);
			if (target === undefined || target.via !== undefined) continue;
			if (isImportedEntity(target)) {
				const module = entityModule(target);
				if (module !== undefined) edge(from, `module ${module}`);
			} else edge(from, fileOf(name));
		}
		if (decl.kind === "entity") {
			for (const module of entityFunctionModules(decl)) {
				if (modules.has(module)) edge(from, `module ${module}`);
			}
		}
	}

	const [found] = cyclesOf(
		[...edges.keys()].sort(),
		(node) => [...(edges.get(node) ?? [])].sort(),
		true,
	);
	if (found === undefined) return issues;
	// Where to report it: the entity whose class closes the loop, else the first entity file in it.
	const entityOfFile = new Map([...files].map(([name, file]) => [file, name]));
	const at = found.findIndex((node) => node.startsWith("module "));
	const baseFile = at >= 0 ? found[at + 1] : undefined;
	const name =
		(baseFile !== undefined ? entityOfFile.get(baseFile) : undefined) ??
		found.map((node) => entityOfFile.get(node)).find((n) => n !== undefined);
	const imported = isImportedEntity(
		name === undefined ? undefined : scope.decls.get(name),
	);
	issues.push({
		path:
			name === undefined
				? ["entities"]
				: imported && baseFile !== undefined
					? ["entities", name, "implementation"]
					: ["entities", name],
		code: "import_cycle",
		message: `The generated files would import each other in a loop: ${found
			.map((node) =>
				node.startsWith("module ") ? node.slice("module ".length) : node,
			)
			.join(
				" -> ",
			)}. A module that holds several classes or functions written by hand joins them, and a blueprint or record that names an entity shares its file with the others: move the class or function to a module of its own, or keep the blueprint or record out of the loop.`,
	});
	return issues;
}
