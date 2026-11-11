/**
 * Collects the exports of a built `.d.ts` entry with the text of their
 * declarations, through the TypeScript compiler API, plus the declarations
 * they reference that the entry does not export, under `(internal) Name`: a
 * change to those changes what the exported types mean, so it shows up too.
 */
import ts from "typescript-language-service";
import { baseOptions } from "./program";

export function apiSurface(entry: string): Record<string, string[]> {
	const program = ts.createProgram([entry], baseOptions);
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry);
	const moduleSymbol = source && checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`Cannot read the module ${entry}.`);

	const distRoot = `${entry.slice(0, entry.lastIndexOf("/dist/"))}/dist/`;
	const surface: Record<string, string[]> = {};
	const exportedDeclarations = new Set<ts.Node>();
	const queue: ts.Node[] = [];
	const visited = new Set<ts.Node>();

	const resolve = (symbol: ts.Symbol) =>
		symbol.flags & ts.SymbolFlags.Alias
			? checker.getAliasedSymbol(symbol)
			: symbol;

	for (const exported of checker.getExportsOfModule(moduleSymbol)) {
		const symbol = resolve(exported);
		const declarations = symbol.declarations ?? [];
		for (const declaration of declarations) {
			exportedDeclarations.add(declaration);
			queue.push(declaration);
		}
		surface[exported.name] = [
			...new Set(declarations.map((declaration) => normalize(declaration))),
		].sort();
	}

	// Walk the type references of the exported declarations, recursively.
	while (queue.length > 0) {
		const node = queue.pop() as ts.Node;
		if (visited.has(node)) continue;
		visited.add(node);
		const visit = (child: ts.Node): void => {
			if (ts.isIdentifier(child) && !isDeclarationName(child)) {
				const raw = checker.getSymbolAtLocation(child);
				if (raw) {
					const symbol = resolve(raw);
					for (const declaration of symbol.declarations ?? []) {
						if (visited.has(declaration)) continue;
						const file = declaration.getSourceFile().fileName;
						if (!file.startsWith(distRoot) || !file.endsWith(".d.ts")) continue;
						if (!isTopLevelDeclaration(declaration)) continue;
						if (!exportedDeclarations.has(declaration)) {
							const key = `(internal) ${symbol.name}`;
							const text = normalize(declaration);
							const known = surface[key] ?? [];
							if (!known.includes(text)) surface[key] = [...known, text].sort();
						}
						queue.push(declaration);
					}
				}
			}
			ts.forEachChild(child, visit);
		};
		ts.forEachChild(node, visit);
	}

	return Object.fromEntries(
		Object.entries(surface).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/** Declarations that can stand on their own, not members or parameters. */
function isTopLevelDeclaration(node: ts.Node): boolean {
	return (
		(ts.isTypeAliasDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isEnumDeclaration(node) ||
			ts.isVariableDeclaration(node)) &&
		(ts.isSourceFile(node.parent) ||
			ts.isVariableDeclarationList(node.parent) ||
			ts.isModuleBlock(node.parent))
	);
}

function isDeclarationName(identifier: ts.Identifier): boolean {
	const parent = identifier.parent as ts.Node & { name?: ts.Node };
	return parent.name === identifier;
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
