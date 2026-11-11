/**
 * Usage report of the stable exports of `@afora/core` (issue #59): for every
 * name exported by `src/index.ts`, where it is used in the examples, the
 * companion packages, the reader path of the docs and the type tests, and
 * whether it is named by the declaration of another stable export that is
 * used. Reads `dist/index.d.ts` (run `bun run build` first) and writes
 * `docs/plans/stable-usage.md`. Run through `bun run stable:usage`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { apiSurface } from "../tests/api-surface/surface";

const root = join(import.meta.dir, "..");
const entry = join(root, "dist/index.d.ts");
const reportPath = join(root, "docs/plans/stable-usage.md");
if (!existsSync(entry))
	throw new Error("dist/ is missing: run `bun run build`.");

const SOURCE = /\.(?:[cm]?[jt]sx?|json|md)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIPPED_FILES = new Set([
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"package.json",
]);

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const item of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, item.name);
		if (item.isDirectory()) {
			if (!SKIPPED_DIRS.has(item.name)) files.push(...walk(path));
		} else if (SOURCE.test(item.name) && !SKIPPED_FILES.has(item.name)) {
			files.push(path);
		}
	}
	return files.sort();
}

const rel = (path: string) => relative(root, path).split("\\").join("/");

type Group = "examples" | "packages" | "docs" | "tests";
type Scanned = { file: string; owner: string; group: Group };

const scanned: Scanned[] = [];
for (const example of ["interop", "blog", "agent-built"])
	for (const file of walk(join(root, "examples", example)))
		scanned.push({ file: rel(file), owner: example, group: "examples" });
for (const pkg of readdirSync(join(root, "packages")).sort())
	for (const file of walk(join(root, "packages", pkg, "src")))
		scanned.push({ file: rel(file), owner: pkg, group: "packages" });
const EXCLUDED_DOCS = new Set(["docs/api-tiers.md"]);
for (const file of [
	join(root, "README.md"),
	...walk(join(root, "docs")).filter((f) => f.endsWith(".md")),
]) {
	const path = rel(file);
	if (
		EXCLUDED_DOCS.has(path) ||
		path.startsWith("docs/plans/") ||
		path.split("/").length > 2
	)
		continue;
	scanned.push({ file: path, owner: "docs", group: "docs" });
}
for (const dir of ["types-compat", "type-perf"])
	for (const file of walk(join(root, "tests", dir)))
		scanned.push({ file: rel(file), owner: dir, group: "tests" });

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const identifiersOf = (text: string) => new Set(text.match(IDENTIFIER) ?? []);

const files = scanned.map((item) => ({
	...item,
	identifiers: identifiersOf(readFileSync(join(root, item.file), "utf8")),
}));

const surface = apiSurface(entry);
const exported = Object.keys(surface).filter(
	(n) => !n.startsWith("(internal)"),
);
const exportedSet = new Set(exported);

function kindOf(name: string): string {
	const kinds = new Set<string>();
	for (const text of surface[name] ?? []) {
		const head = text.replace(/^(export |declare )+/, "");
		if (head.startsWith("abstract class")) kinds.add("class");
		else if (head.startsWith("class")) kinds.add("class");
		else if (head.startsWith("function")) kinds.add("function");
		else if (head.startsWith("const") || head.startsWith("let"))
			kinds.add("const");
		else if (head.startsWith("interface")) kinds.add("interface");
		else if (head.startsWith("type")) kinds.add("type");
		else if (head.startsWith("enum")) kinds.add("enum");
		else if (head.startsWith("namespace")) kinds.add("namespace");
		else if (/^[\w$]+\s*[:=]/.test(head)) kinds.add("const");
		else kinds.add("other");
	}
	return [...kinds].sort().join(" + ");
}

type Usage = Record<Group, Scanned[]>;
const usage = new Map<string, Usage>();
for (const name of exported) {
	const found: Usage = { examples: [], packages: [], docs: [], tests: [] };
	for (const f of files)
		if (f.identifiers.has(name))
			found[f.group].push({ file: f.file, owner: f.owner, group: f.group });
	usage.set(name, found);
}

const isUsed = (name: string) => {
	const u = usage.get(name) as Usage;
	return u.examples.length + u.packages.length + u.docs.length > 0;
};

// Edges: a declaration (exported or internal) names these identifiers.
const edges = new Map<string, Set<string>>();
for (const [key, texts] of Object.entries(surface)) {
	const names = new Set<string>();
	for (const text of texts)
		for (const id of identifiersOf(text)) {
			if (id === key.replace("(internal) ", "")) continue;
			names.add(exportedSet.has(id) ? id : `(internal) ${id}`);
		}
	edges.set(key, names);
}

const used = exported.filter(isUsed);
const directReferrers = new Map<string, string[]>();
for (const user of used)
	for (const target of edges.get(user) ?? [])
		if (exportedSet.has(target) && target !== user)
			directReferrers.set(target, [
				...(directReferrers.get(target) ?? []),
				user,
			]);

// Reachable from a used export through any chain of declarations.
const reachable = new Set<string>();
const queue = [...used];
while (queue.length > 0) {
	const key = queue.pop() as string;
	for (const target of edges.get(key) ?? [])
		if (!reachable.has(target)) {
			reachable.add(target);
			queue.push(target);
		}
}

const summarize = (list: Scanned[], limit = 2) => {
	if (list.length === 0) return "-";
	const counts = new Map<string, number>();
	for (const item of list)
		counts.set(item.owner, (counts.get(item.owner) ?? 0) + 1);
	const parts = [...counts].sort(([a], [b]) => (a < b ? -1 : 1));
	const shown = parts.slice(0, limit).map(([o, n]) => `${o} ${n}`);
	return parts.length > limit
		? `${shown.join(", ")}, +${parts.length - limit}`
		: shown.join(", ");
};
const docsCell = (list: Scanned[]) =>
	list.length === 0 ? "-" : `${list.length}`;

const referencedCell = (name: string) => {
	const direct = [...new Set(directReferrers.get(name) ?? [])].sort();
	if (direct.length > 0)
		return direct.length > 3
			? `${direct.slice(0, 3).join(", ")}, +${direct.length - 3}`
			: direct.join(", ");
	return reachable.has(name) ? "(transitive)" : "-";
};

const unusedExports = exported.filter((n) => !isUsed(n));
const unusedFree = unusedExports.filter((n) => !reachable.has(n));
const unusedReferenced = unusedExports.filter((n) => reachable.has(n));

const rows = exported.map((name) => {
	const u = usage.get(name) as Usage;
	return `| \`${name}\` | ${kindOf(name)} | ${summarize(u.examples)} | ${summarize(u.packages)} | ${docsCell(u.docs)} | ${docsCell(u.tests)} | ${referencedCell(name)} |`;
});

const list = (names: string[]) =>
	names.length === 0
		? "None.\n"
		: `${names.map((n) => `- \`${n}\` (${kindOf(n)})${usage.get(n)?.tests.length ? ", used only in type tests" : ""}`).join("\n")}\n`;

const report = `# Usage of the stable exports

Report for issue #59, generated by \`scripts/stable-usage.ts\`. Regenerate with \`bun run stable:usage\` (reads \`dist/\`, so run \`bun run build\` first); the output is sorted, so re-running gives no diff unless usage changed.

Every name exported by \`src/index.ts\` (values and types) is looked up as a whole identifier in:

- **Examples**: \`examples/interop\`, \`examples/blog\`, \`examples/agent-built\` (sources, \`afora.json\` and Markdown; no \`node_modules\`, lockfiles or \`package.json\`).
- **Packages**: \`packages/*/src\`, which includes the import lines that \`packages/codegen\` emits into generated code.
- **Docs**: the reader path, \`README.md\` and \`docs/*.md\`, without \`docs/api-tiers.md\`, \`docs/plans/**\` and \`CHANGELOG.md\`.
- **Tests**: \`tests/types-compat\` and \`tests/type-perf\`. Lower weight, reported separately and not counted as use.

Cells show file counts (examples and packages by example or package name). **Referenced by** lists the used stable exports whose declaration names the export (from the \`apiSurface\` declaration text), so moving it out of stable would break code naming it; \`(transitive)\` means it is reached only through a chain of declarations (including non-exported ones) starting at a used export. "Used" means at least one file in Examples, Packages or Docs; a name is matched by identifier, not by import, so a common word may be over-counted.

**Summary**: ${exported.length} stable exports, ${used.length} used, ${unusedExports.length} unused (${unusedFree.length} unused and not referenced by a used export, ${unusedReferenced.length} unused but referenced by a used export).

| Export | Kind | Examples | Packages | Docs | Tests | Referenced by |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Unused

Exports with zero usage in examples, packages and docs.

### Unused and not referenced by a used export (${unusedFree.length})

Unused and unreferenced: candidates to move out of stable.

${list(unusedFree)}
### Unused but referenced by a used export (${unusedReferenced.length})

Moving these out of stable would break code that names a type in the signature of a used export.

${list(unusedReferenced)}`;

writeFileSync(reportPath, report);
console.log(
	`${exported.length} exports, ${used.length} used, ${unusedFree.length} unused and unreferenced, ${unusedReferenced.length} unused but referenced.`,
);
