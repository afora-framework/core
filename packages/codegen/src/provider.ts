import { issue } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { ProviderCatalogEntry, SpecIssue } from "./spec/types";

type Path = readonly (string | number)[];

/** The provider every codegen knows: `inMemoryProvider()` of `@afora/core`. */
const BUILTIN_PROVIDER = "inMemory";

/** `"./db.ts#provider"` taken apart; undefined when it is not `module#identifier`. */
export function parseImportRef(
	text: unknown,
): { module: string; name: string } | undefined {
	if (typeof text !== "string") return undefined;
	const at = text.lastIndexOf("#");
	if (at <= 0) return undefined;
	const [module, name] = [text.slice(0, at), text.slice(at + 1)];
	if (/\s|#/.test(module) || !isIdentifier(name)) return undefined;
	return { module, name };
}

/** An object with only `import`: a reference, not a value. */
export const isImportObject = (
	value: unknown,
): value is { readonly import: unknown } =>
	isObject(value) && Object.hasOwn(value, "import");

export function checkImport(
	value: Readonly<Record<string, unknown>>,
	path: Path,
	issues: SpecIssue[],
): void {
	if (Object.keys(value).length !== 1 || !parseImportRef(value.import)) {
		issues.push(
			issue(
				path,
				"invalid_import",
				'An import is { "import": "./file.ts#exportName" }: the module (relative to the output directory, or a package), "#" and the exported name; it takes no other key.',
			),
		);
	}
}

function checkOption(value: unknown, path: Path, issues: SpecIssue[]): void {
	if (value === null || typeof value === "string") return;
	if (typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			issues.push(
				issue(path, "invalid_provider", "A number option must be finite."),
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			checkOption(item, [...path, index], issues);
		}
		return;
	}
	if (isObject(value)) {
		if (isImportObject(value)) {
			checkImport(value, path, issues);
			return;
		}
		for (const [key, item] of Object.entries(value)) {
			checkOption(item, [...path, key], issues);
		}
		return;
	}
	issues.push(
		issue(
			path,
			"invalid_provider",
			'Provider options are JSON values or { "import": "./file.ts#name" } references.',
		),
	);
}

/** Checks one `provider` of the spec (never evaluating its imports). */
export function checkProvider(
	value: unknown,
	path: Path,
	catalog: readonly ProviderCatalogEntry[],
	issues: SpecIssue[],
): void {
	const names = [BUILTIN_PROVIDER, ...catalog.map((entry) => entry.name)];
	if (typeof value === "string") {
		if (value !== BUILTIN_PROVIDER) {
			issues.push(
				issue(
					path,
					"unknown_provider",
					`"${value}" is not a provider. A bare string is only "${BUILTIN_PROVIDER}"; for a catalog provider use { "use": "${value}" }. Available: ${names.join(", ")}.`,
				),
			);
		}
		return;
	}
	if (!isObject(value)) {
		issues.push(
			issue(
				path,
				"invalid_provider",
				'A provider is "inMemory", { "use": "<name>", "options": {...} } or { "import": "./file.ts#name" }.',
			),
		);
		return;
	}
	if (Object.hasOwn(value, "import")) {
		checkImport(value, path, issues);
		return;
	}
	if (!Object.hasOwn(value, "use")) {
		issues.push(
			issue(
				path,
				"invalid_provider",
				'A provider object has "use" (a catalog name) or "import" (a reference).',
			),
		);
		return;
	}
	for (const key of Object.keys(value)) {
		if (key !== "use" && key !== "options") {
			issues.push(
				issue(
					[...path, key],
					"invalid_provider",
					`"${key}" is not valid here. Valid keys: use, options.`,
				),
			);
		}
	}
	const { use, options } = value;
	if (typeof use !== "string" || !names.includes(use)) {
		issues.push(
			issue(
				[...path, "use"],
				"unknown_provider",
				`${typeof use === "string" ? `"${use}"` : '"use"'} is not a provider of the catalog. Available: ${names.join(", ")}. External providers are supplied to codegen as the \`providers\` option.`,
			),
		);
	}
	if (options === undefined) return;
	if (!isObject(options)) {
		issues.push(
			issue(
				[...path, "options"],
				"invalid_provider",
				'"options" must be an object.',
			),
		);
		return;
	}
	if (use === BUILTIN_PROVIDER && Object.keys(options).length > 0) {
		issues.push(
			issue(
				[...path, "options"],
				"invalid_provider",
				`"${BUILTIN_PROVIDER}" takes no options.`,
			),
		);
		return;
	}
	for (const [key, item] of Object.entries(options)) {
		checkOption(item, [...path, "options", key], issues);
	}
}

/** Problems of the catalog given to codegen itself. */
export function checkCatalog(
	catalog: readonly ProviderCatalogEntry[],
	issues: SpecIssue[],
): void {
	const seen = new Set<string>([BUILTIN_PROVIDER]);
	for (const [index, entry] of catalog.entries()) {
		const bad = (message: string) =>
			issues.push(
				issue(
					[],
					"invalid_provider_catalog",
					`providers[${index}]: ${message}`,
				),
			);
		if (!isObject(entry)) {
			bad("an entry is { name, module, export }.");
			continue;
		}
		if (typeof entry.name !== "string" || entry.name === "") {
			bad('"name" must be a non-empty string.');
		} else if (seen.has(entry.name)) {
			bad(
				`"${entry.name}" is ${entry.name === BUILTIN_PROVIDER ? "built in" : "listed twice"}.`,
			);
		} else seen.add(entry.name);
		if (typeof entry.module !== "string" || entry.module === "") {
			bad(
				'"module" must be a package or a path relative to the output directory.',
			);
		}
		if (typeof entry.export !== "string" || !isIdentifier(entry.export)) {
			bad('"export" must be the name of the factory.');
		}
	}
}
