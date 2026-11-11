/**
 * Checks that every export of the stable (`@afora/core`), adapters and testing
 * entries is documented on a page (issue #93). Experimental is excluded.
 *
 * - A value (function, class, const, enum) is covered when its name appears
 *   as a whole word, in prose, `code` or code blocks, in README.md, docs/**
 *   (except docs/api-tiers.md, docs/plans/** and docs/reference/api.md) or
 *   packages/* /README.md.
 * - A type (type alias, interface) is covered by the same, or by the
 *   generated docs/reference/api.md.
 *
 * Reads the exports of the built `dist/*.d.ts` (the published surface), so
 * run `bun run build` first; it stops with a clear message when dist/ is missing.
 *
 *   bun scripts/check-doc-coverage.ts            misses, exit 1 if any
 *   bun scripts/check-doc-coverage.ts --report   same output, exit 0
 *   bun scripts/check-doc-coverage.ts --json     machine output (exit as above unless --report)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { builtExports, root } from "../tests/api-surface/program";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const reportOnly = args.has("--report");

const apiReference = join(root, "docs/reference/api.md");
const excluded = new Set([join(root, "docs/api-tiers.md"), apiReference]);
const pages = [
	...new Bun.Glob("README.md").scanSync(root),
	...new Bun.Glob("docs/**/*.md").scanSync(root),
	...new Bun.Glob("packages/*/README.md").scanSync(root),
]
	.map((file) => join(root, file))
	.filter(
		(file) =>
			!excluded.has(file) && !relative(root, file).startsWith("docs/plans/"),
	)
	.sort();

const pageText = pages.map((file) => readFileSync(file, "utf8")).join("\n");
const referenceText = existsSync(apiReference)
	? readFileSync(apiReference, "utf8")
	: "";

const mentions = (text: string, name: string) =>
	new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

interface Miss {
	values: string[];
	types: string[];
	total: number;
}
const misses: Record<string, Miss> = {};
let totalMissed = 0;
let totalExports = 0;

for (const { entry, exports } of builtExports()) {
	if (entry.tier === "experimental") continue;
	const miss: Miss = { values: [], types: [], total: exports.length };
	for (const info of exports) {
		const covered =
			mentions(pageText, info.name) ||
			(!info.isValue && mentions(referenceText, info.name));
		if (!covered) (info.isValue ? miss.values : miss.types).push(info.name);
	}
	misses[entry.specifier] = miss;
	totalMissed += miss.values.length + miss.types.length;
	totalExports += exports.length;
}

if (asJson) {
	console.log(
		JSON.stringify(
			{ exports: totalExports, missed: totalMissed, misses },
			null,
			2,
		),
	);
} else {
	for (const [entry, miss] of Object.entries(misses)) {
		console.log(
			`${entry}: ${miss.values.length} value(s) and ${miss.types.length} type(s) not documented, of ${miss.total} exports`,
		);
		if (miss.values.length) console.log(`  values: ${miss.values.join(", ")}`);
		if (miss.types.length) console.log(`  types:  ${miss.types.join(", ")}`);
	}
	console.log(
		`\n${totalExports - totalMissed}/${totalExports} exports covered by ${pages.length} pages` +
			(totalMissed
				? "; document the misses on a page of docs/ (types may instead get a JSDoc, then `bun run docs:api`)."
				: "."),
	);
}
process.exit(totalMissed > 0 && !reportOnly ? 1 : 0);
