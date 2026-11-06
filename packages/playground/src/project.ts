import { dirname, join, resolve } from "node:path";
import ts from "typescript-language-service";

export function createProject(directory: string, source = false) {
	const root = resolve(directory);
	const fileName = join(root, "__afora_playground__.ts");
	let text = "";
	let version = 0;
	let service: ts.LanguageService;
	let configErrors: ts.Diagnostic[] = [];
	function reload() {
		service?.dispose();
		const configPath = ts.findConfigFile(root, ts.sys.fileExists);
		const config = configPath
			? ts.readConfigFile(configPath, ts.sys.readFile)
			: { config: {} };
		const parsed = ts.parseJsonConfigFileContent(
			config.config ?? {},
			ts.sys,
			configPath ? dirname(configPath) : root,
		);
		configErrors = config.error
			? [config.error]
			: parsed.errors.filter((error) => error.code !== 18003);
		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			skipLibCheck: true,
			...parsed.options,
			noEmit: true,
			allowNonTsExtensions: true,
		};
		if (source) {
			options.paths = {
				...options.paths,
				"@afora/core": [join(root, "src/index.ts")],
			};
		}
		// Only the editor buffer changes between queries. Dependency files keep a
		// fixed version (and a cached snapshot) until `reload()`, so TypeScript
		// reuses their parsed source files instead of rebuilding the whole program
		// on every keystroke.
		const snapshots = new Map<string, ts.IScriptSnapshot | undefined>();
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
			getCompilationSettings: () => options,
			getDefaultLibFileName: () =>
				join(import.meta.dir, "typescript/lib.esnext.full.d.ts"),
			fileExists: (file) => file === fileName || ts.sys.fileExists(file),
			readFile: (file) => (file === fileName ? text : ts.sys.readFile(file)),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			realpath: ts.sys.realpath,
		};
		// During development the compiler's own library files are already installed.
		if (!ts.sys.fileExists(host.getDefaultLibFileName(options))) {
			host.getDefaultLibFileName = (opts) => ts.getDefaultLibFilePath(opts);
		}
		service = ts.createLanguageService(host);
	}
	reload();
	return {
		root,
		reload,
		dispose: () => service.dispose(),
		query(
			code: string,
			action: string,
			position = 0,
			name = "",
			completionSource?: string,
		) {
			if (text !== code) {
				text = code;
				version++;
			}
			if (action === "complete") {
				return (
					service.getCompletionsAtPosition(fileName, position, {
						includeCompletionsForModuleExports: true,
						includeCompletionsWithInsertText: true,
					})?.entries ?? []
				);
			}
			if (action === "details") {
				return (
					service.getCompletionEntryDetails(
						fileName,
						position,
						name,
						{},
						completionSource,
						{},
						undefined,
					) ?? null
				);
			}
			if (action === "hover")
				return service.getQuickInfoAtPosition(fileName, position) ?? null;
			if (action === "signature")
				return (
					service.getSignatureHelpItems(fileName, position, undefined) ?? null
				);
			if (action !== "diagnostics")
				throw new Error("Unknown language service action");
			return [
				...configErrors,
				...service.getSyntacticDiagnostics(fileName),
				...service.getSemanticDiagnostics(fileName),
			].map((diagnostic) => ({
				start: diagnostic.start ?? 0,
				length: diagnostic.length ?? 1,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				category: diagnostic.category,
				code: diagnostic.code,
			}));
		},
	};
}

export async function projectInfo(root: string) {
	const manifest = await Bun.file(join(root, "package.json")).json();
	const dependencies = Object.entries({
		...manifest.devDependencies,
		...manifest.dependencies,
	}).map(([name, requested]) => {
		let installed: string | null = null;
		let folder = root;
		while (true) {
			const contents = ts.sys.readFile(
				join(folder, "node_modules", name, "package.json"),
			);
			if (contents) {
				installed = JSON.parse(contents).version;
				break;
			}
			const parent = dirname(folder);
			if (parent === folder) break;
			folder = parent;
		}
		return { name, requested: String(requested), installed };
	});
	return {
		name: manifest.name ?? "Projeto local",
		root,
		dependencies,
		manifest,
	};
}
