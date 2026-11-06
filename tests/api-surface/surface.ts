/**
 * Collects the exports of a built `.d.ts` entry with the text of their
 * declarations, through the TypeScript compiler API.
 */
import ts from "typescript-language-service";

export function apiSurface(entry: string): Record<string, string[]> {
	const program = ts.createProgram([entry], {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		lib: ["lib.esnext.d.ts"],
		types: [],
		skipLibCheck: true,
		noEmit: true,
		allowImportingTsExtensions: true,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry);
	const moduleSymbol = source && checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`Cannot read the module ${entry}.`);

	const surface: Record<string, string[]> = {};
	for (const exported of checker.getExportsOfModule(moduleSymbol)) {
		const symbol =
			exported.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol(exported)
				: exported;
		const declarations = (symbol.declarations ?? []).map((declaration) =>
			normalize(declaration),
		);
		surface[exported.name] = [...new Set(declarations)].sort();
	}
	return Object.fromEntries(
		Object.entries(surface).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/**
 * The declaration without comments (the printer drops them) and with
 * whitespace collapsed, so formatting is not part of the contract. Import
 * specifiers are relative, so no absolute path appears.
 */
function normalize(node: ts.Node): string {
	const printer = ts.createPrinter({ removeComments: true });
	return printer
		.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
		.replace(/\s+/g, " ")
		.trim();
}
