/**
 * An isolated TypeScript language service over one virtual file, to measure
 * what an editor pays per edit and to record what it shows (hovers,
 * completions, signatures, diagnostics). Run through `bun run test:type-perf`.
 */
import { join } from "node:path";
import ts from "typescript-language-service";

/**
 * `source` resolves `@afora/core` to `src/index.ts`, as contributors to afora
 * see it; `package` resolves it through the
 * package `exports` to `dist/`, as a consumer sees it.
 */
export type Mode = "source" | "package";

const root = join(import.meta.dir, "../..");
const fileName = join(root, "__type_perf__.ts");

const options: ts.CompilerOptions = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	lib: ["lib.esnext.d.ts"],
	types: [],
	strict: true,
	skipLibCheck: true,
	noEmit: true,
	allowImportingTsExtensions: true,
};

function session(mode: Mode) {
	let text = "";
	let version = 0;
	const snapshots = new Map<string, ts.IScriptSnapshot | undefined>();
	const settings: ts.CompilerOptions =
		mode === "source"
			? { ...options, paths: { "@afora/core": [join(root, "src/index.ts")] } }
			: options;
	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => [fileName],
		getScriptVersion: (file) => (file === fileName ? String(version) : "0"),
		getScriptSnapshot: (file) => {
			if (file === fileName) return ts.ScriptSnapshot.fromString(text);
			if (!snapshots.has(file)) {
				const contents = ts.sys.readFile(file);
				snapshots.set(
					file,
					contents === undefined
						? undefined
						: ts.ScriptSnapshot.fromString(contents),
				);
			}
			return snapshots.get(file);
		},
		getCurrentDirectory: () => root,
		getCompilationSettings: () => settings,
		getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
		fileExists: (file) => file === fileName || ts.sys.fileExists(file),
		readFile: (file) => (file === fileName ? text : ts.sys.readFile(file)),
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		realpath: ts.sys.realpath,
	};
	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	return {
		service,
		get text() {
			return text;
		},
		write(next: string) {
			text = next;
			version++;
		},
		// `getInstantiationCount` is public at runtime but marked @internal in
		// the declarations; it is what `tsc --extendedDiagnostics` reports.
		instantiations: () =>
			(
				service.getProgram()?.getTypeChecker() as
					| (ts.TypeChecker & { getInstantiationCount(): number })
					| undefined
			)?.getInstantiationCount() ?? 0,
		dispose: () => service.dispose(),
	};
}

export interface EditCost {
	/** Type instantiations of the checker created for the edit: deterministic. */
	readonly instantiations: number;
	/** Wall time of the semantic check after the edit: indicative only. */
	readonly ms: number;
}

/**
 * The cost of one keystroke once dependencies are loaded: the code is checked
 * once (parsing every dependency), edited, and checked again. TypeScript makes
 * a new checker for every edit, so this is what each one pays.
 */
export function measureEdit(code: string, mode: Mode): EditCost {
	const s = session(mode);
	try {
		s.write(strip(code).text);
		s.service.getSemanticDiagnostics(fileName);
		s.write(`${s.text}\n// edit\n`);
		const start = performance.now();
		s.service.getSemanticDiagnostics(fileName);
		const ms = performance.now() - start;
		return { instantiations: s.instantiations(), ms };
	} finally {
		s.dispose();
	}
}

/**
 * Probes in the code, as `ctx./*@complete*\/`: `hover` at the identifier
 * after the marker, `complete` and `signature` at the marker.
 */
const MARKER = /\/\*@(hover|complete|signature)\*\//g;
type ProbeKind = "hover" | "complete" | "signature";

function strip(code: string) {
	const probes: { kind: ProbeKind; position: number }[] = [];
	let removed = 0;
	const text = code.replace(
		MARKER,
		(match, kind: ProbeKind, offset: number) => {
			probes.push({ kind, position: offset - removed });
			removed += match.length;
			return "";
		},
	);
	return { text, probes };
}

const flatten = (parts?: readonly ts.SymbolDisplayPart[]) =>
	parts?.map((part) => part.text).join("") ?? "";

/** What the editor shows for the probes and the diagnostics of the code. */
export function experience(code: string, mode: Mode): string[] {
	const s = session(mode);
	try {
		const { text, probes } = strip(code);
		s.write(text);
		const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext);
		const at = (position: number) => {
			const { line, character } =
				source.getLineAndCharacterOfPosition(position);
			const lineText = text.split("\n")[line] ?? "";
			const caret = `${lineText.slice(0, character)}‸${lineText.slice(character)}`;
			return `L${line + 1}:${character + 1} ${caret.trim()}`;
		};
		const lines: string[] = [];
		for (const { kind, position } of probes) {
			lines.push(`${kind} ${at(position)}`);
			lines.push(...probe(s.service, kind, position).map((l) => `  ${l}`));
		}
		const diagnostics = [
			...s.service.getSyntacticDiagnostics(fileName),
			...s.service.getSemanticDiagnostics(fileName),
		];
		lines.push(`diagnostics (${diagnostics.length})`);
		for (const d of diagnostics) {
			lines.push(`  TS${d.code} ${at(d.start ?? 0)}`);
			const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
			lines.push(...message.split("\n").map((l) => `    ${l}`));
		}
		// Absolute paths would tie the record to this machine.
		return lines.map((line) => line.replaceAll(root, "<root>"));
	} finally {
		s.dispose();
	}
}

function probe(
	service: ts.LanguageService,
	kind: ProbeKind,
	position: number,
): string[] {
	if (kind === "hover") {
		const info = service.getQuickInfoAtPosition(fileName, position);
		if (!info) return ["(nothing)"];
		const docs = flatten(info.documentation);
		return [
			...flatten(info.displayParts).split("\n"),
			...(docs ? docs.split("\n").map((l) => `// ${l}`) : []),
		];
	}
	if (kind === "complete") {
		const entries =
			service.getCompletionsAtPosition(fileName, position, {})?.entries ?? [];
		if (!entries.length) return ["(nothing)"];
		return [...entries]
			.sort(
				(a, b) =>
					a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name),
			)
			.map((entry) => `${entry.name} (${entry.kind})`);
	}
	const help = service.getSignatureHelpItems(fileName, position, undefined);
	if (!help) return ["(nothing)"];
	return help.items.map((item, index) => {
		const params = item.parameters
			.map((p) => flatten(p.displayParts))
			.join(flatten(item.separatorDisplayParts));
		const mark = index === help.selectedItemIndex ? "*" : " ";
		return `${mark} ${flatten(item.prefixDisplayParts)}${params}${flatten(item.suffixDisplayParts)}  [arg ${help.argumentIndex}]`;
	});
}
