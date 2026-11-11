/**
 * Shared TypeScript program plumbing for the API checks: the four public
 * entries of the built package, their exports with their JSDoc, and a
 * type-checker for many virtual modules at once (documentation examples and
 * code blocks of the docs). Uses `typescript-language-service` (TS 5.9): the
 * `typescript` devDependency is the native 7.x without a JS API.
 */
import { join } from "node:path";
import ts from "typescript-language-service";

export const root = join(import.meta.dir, "../..");

export type Tier = "stable" | "adapters" | "experimental" | "testing";

export interface EntryPoint {
	/** Import specifier of consumers. */
	specifier: string;
	tier: Tier;
	/** Built declaration file. */
	dts: string;
	/** Source module, for checks that do not need a build. */
	src: string;
}

export const entryPoints: EntryPoint[] = [
	{
		specifier: "@afora/core",
		tier: "stable",
		dts: join(root, "dist/index.d.ts"),
		src: join(root, "src/index.ts"),
	},
	{
		specifier: "@afora/core/adapters",
		tier: "adapters",
		dts: join(root, "dist/adapters.d.ts"),
		src: join(root, "src/adapters.ts"),
	},
	{
		specifier: "@afora/core/experimental",
		tier: "experimental",
		dts: join(root, "dist/experimental.d.ts"),
		src: join(root, "src/experimental.ts"),
	},
	{
		specifier: "@afora/core/testing",
		tier: "testing",
		dts: join(root, "dist/testing/index.d.ts"),
		src: join(root, "src/testing/index.ts"),
	},
];

export const baseOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	lib: ["lib.esnext.d.ts"],
	types: [],
	skipLibCheck: true,
	noEmit: true,
	allowImportingTsExtensions: true,
};

/** Options of the root `tsconfig.json`, for code that is type-checked as the repo is. */
export const projectOptions: ts.CompilerOptions = {
	...baseOptions,
	module: ts.ModuleKind.Preserve,
	moduleDetection: ts.ModuleDetectionKind.Force,
	jsx: ts.JsxEmit.ReactJSX,
	allowJs: true,
	types: ["bun"],
	typeRoots: [join(root, "node_modules/@types")],
	verbatimModuleSyntax: true,
	strict: true,
	noFallthroughCasesInSwitch: true,
	noUncheckedIndexedAccess: true,
	noImplicitOverride: true,
};

export type ExportKind =
	| "function"
	| "class"
	| "const"
	| "type"
	| "interface"
	| "enum"
	| "namespace";

export interface ExportInfo {
	name: string;
	kind: ExportKind;
	/** True when the export has a runtime value (function, class, const, enum). */
	isValue: boolean;
	/** JSDoc summary text, empty when undocumented. */
	summary: string;
	/** JSDoc tags: name -> texts, in source order. */
	tags: { name: string; text: string }[];
	documented: boolean;
}

export interface EntryExports {
	entry: EntryPoint;
	exports: ExportInfo[];
}

/** The exports of one entry with their kind and JSDoc, re-exports resolved. */
export function exportsOfEntry(entry: EntryPoint, file: string): EntryExports {
	const program = ts.createProgram([file], baseOptions);
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(file);
	const moduleSymbol = source && checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`Cannot read the module ${file}.`);

	const exports: ExportInfo[] = [];
	for (const exported of checker.getExportsOfModule(moduleSymbol)) {
		const symbol =
			exported.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol(exported)
				: exported;
		const summary = ts.displayPartsToString(
			symbol.getDocumentationComment(checker),
		);
		const tags = symbol.getJsDocTags(checker).map((tag) => ({
			name: tag.name,
			text: ts.displayPartsToString(tag.text),
		}));
		// A declaration with JSDoc is enough (overloads, const + type merges).
		const hasDeclarationDoc = (symbol.declarations ?? []).some((declaration) =>
			hasJsDoc(declaration),
		);
		exports.push({
			name: exported.name,
			kind: kindOf(symbol),
			isValue: (symbol.flags & ts.SymbolFlags.Value) !== 0,
			summary,
			tags,
			documented: summary.trim() !== "" || hasDeclarationDoc,
		});
	}
	exports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { entry, exports };
}

function kindOf(symbol: ts.Symbol): ExportKind {
	const flags = symbol.flags;
	if (flags & ts.SymbolFlags.Class) return "class";
	if (flags & ts.SymbolFlags.Function) return "function";
	if (flags & ts.SymbolFlags.Enum) return "enum";
	if (flags & ts.SymbolFlags.Variable) {
		// A const whose type is a function reads as a function to users.
		return "const";
	}
	if (flags & ts.SymbolFlags.Interface) return "interface";
	if (flags & ts.SymbolFlags.TypeAlias) return "type";
	return "namespace";
}

/** The built entries; throws a clear error when `dist/` is missing. */
export function builtExports(): EntryExports[] {
	return entryPoints.map((entry) => {
		if (!Bun.file(entry.dts).size)
			throw new Error(`${entry.dts} is missing: run \`bun run build\` first.`);
		return exportsOfEntry(entry, entry.dts);
	});
}

/** Code of each `@example` tag of an export, fences stripped. */
export function examplesOf(info: ExportInfo): string[] {
	return info.tags
		.filter((tag) => tag.name === "example")
		.map((tag) => stripFences(tag.text));
}

export function stripFences(text: string): string {
	const fenced = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	return (fenced ? (fenced[1] as string) : text).trim();
}

export interface VirtualModule {
	/** Label for reports. */
	id: string;
	code: string;
}

export interface ModuleDiagnostics {
	id: string;
	diagnostics: string[];
}

/**
 * Type-checks many modules in one program. `paths` maps bare specifiers to
 * files. Virtual files live under `<root>/__virtual__/` so bare imports
 * resolve from the repository's `node_modules`. Each is a module (top-level
 * await allowed). A bare import that does not resolve from there is looked up
 * again from each directory of `fallbackRoots`, in order (as if imported from
 * a file in it, so `node_modules` and package `exports` apply). Returns only
 * the modules with diagnostics.
 */
export function checkVirtualModules(
	modules: VirtualModule[],
	paths: Record<string, string[]>,
	options: ts.CompilerOptions = projectOptions,
	fallbackRoots: string[] = [],
): ModuleDiagnostics[] {
	const dir = join(root, "__virtual__");
	const files = new Map<string, string>();
	const ids = new Map<string, string>();
	modules.forEach((module, index) => {
		const name = join(dir, `m${index}.ts`);
		files.set(name, `${module.code}\nexport {};\n`);
		ids.set(name, module.id);
	});

	const compilerOptions: ts.CompilerOptions = {
		...options,
		moduleDetection: ts.ModuleDetectionKind.Force,
		baseUrl: undefined,
		paths,
		// The sources of a docs example run under Bun, as the repo does.
		allowArbitraryExtensions: true,
	};
	const host = ts.createCompilerHost(compilerOptions);
	const real = {
		getSourceFile: host.getSourceFile.bind(host),
		fileExists: host.fileExists.bind(host),
		readFile: host.readFile.bind(host),
	};
	host.fileExists = (file) => files.has(file) || real.fileExists(file);
	host.readFile = (file) => files.get(file) ?? real.readFile(file);
	host.getSourceFile = (file, languageVersion, ...rest) => {
		const text = files.get(file);
		return text === undefined
			? real.getSourceFile(file, languageVersion, ...rest)
			: ts.createSourceFile(file, text, languageVersion, true);
	};
	if (fallbackRoots.length > 0) {
		const cache = ts.createModuleResolutionCache(
			root,
			(name) => name,
			compilerOptions,
		);
		const resolve = (name: string, from: string, mode: ts.ResolutionMode) =>
			ts.resolveModuleName(
				name,
				from,
				compilerOptions,
				host,
				cache,
				undefined,
				mode,
			).resolvedModule;
		host.resolveModuleNameLiterals = (literals, containingFile, _, __, file) =>
			literals.map((literal) => {
				const name = literal.text;
				const mode = ts.getModeForUsageLocation(file, literal, compilerOptions);
				let resolved = resolve(name, containingFile, mode);
				if (!resolved && !name.startsWith(".") && !name.startsWith("/"))
					for (const dir of fallbackRoots) {
						resolved = resolve(name, join(dir, "__resolve__.ts"), mode);
						if (resolved) break;
					}
				return { resolvedModule: resolved };
			});
	}

	const program = ts.createProgram([...files.keys()], compilerOptions, host);
	const failures: ModuleDiagnostics[] = [];
	for (const [file, id] of ids) {
		const source = program.getSourceFile(file);
		if (!source) continue;
		const found = [
			...program.getSyntacticDiagnostics(source),
			...program.getSemanticDiagnostics(source),
		];
		if (found.length === 0) continue;
		failures.push({
			id,
			diagnostics: found.map((diagnostic) => {
				const message = ts.flattenDiagnosticMessageText(
					diagnostic.messageText,
					"\n",
				);
				const at =
					diagnostic.start === undefined
						? ""
						: `${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1}:${source.getLineAndCharacterOfPosition(diagnostic.start).character + 1} `;
				return `${at}TS${diagnostic.code}: ${message}`;
			}),
		});
	}
	return failures;
}

/** `paths` that resolve the `@afora/core*` specifiers to the built declarations. */
export function distPaths(): Record<string, string[]> {
	return Object.fromEntries(
		entryPoints.map((entry) => [entry.specifier, [entry.dts]]),
	);
}

/** JSDoc attached to a declaration or, for a variable, to its statement. */
function hasJsDoc(declaration: ts.Declaration): boolean {
	const own = (node: ts.Node) =>
		((node as { jsDoc?: unknown[] }).jsDoc?.length ?? 0) > 0;
	if (own(declaration)) return true;
	const statement = declaration.parent?.parent;
	return ts.isVariableDeclaration(declaration) && !!statement && own(statement);
}
