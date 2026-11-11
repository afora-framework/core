/**
 * Checks that every relative markdown link, and every `#anchor`, in the
 * README, the docs, the package READMEs and the example READMEs resolves,
 * and that docs/nav.json (the navigation of the site, see docs/site.md) is
 * complete: each path exists, is listed once and has a known type, and every
 * page of docs/ (apart from docs/plans/) is listed.
 * Run: `bun scripts/check-doc-links.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [
	...new Bun.Glob("README.md").scanSync(root),
	...new Bun.Glob("docs/**/*.md").scanSync(root),
	...new Bun.Glob("packages/*/README.md").scanSync(root),
	...new Bun.Glob("examples/*/README.md").scanSync(root),
];

/** The anchor GitHub gives a heading. */
const slugOf = (heading: string): string =>
	heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s/g, "-");

function anchorsOf(path: string): Set<string> {
	const anchors = new Set<string>();
	let fenced = false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.startsWith("```")) fenced = !fenced;
		const heading = fenced ? null : /^#{1,6}\s+(.*)$/.exec(line)?.[1];
		if (heading) anchors.add(slugOf(heading.replace(/`/g, "")));
	}
	return anchors;
}

const problems: string[] = [];
for (const file of files) {
	const path = resolve(root, file);
	let fenced = false;
	for (const [index, line] of readFileSync(path, "utf8")
		.split("\n")
		.entries()) {
		if (line.startsWith("```")) fenced = !fenced;
		if (fenced) continue;
		for (const match of line
			.replace(/`[^`]*`/g, "")
			.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = match[1] as string;
			if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
			const [rawPath = "", anchor] = target.split("#");
			const destination = rawPath ? resolve(dirname(path), rawPath) : path;
			const where = `${file}:${index + 1}: ${target}`;
			if (!existsSync(destination)) problems.push(`${where} (no such file)`);
			else if (anchor && destination.endsWith(".md")) {
				if (!anchorsOf(destination).has(anchor))
					problems.push(`${where} (no such anchor)`);
			}
		}
	}
}

interface NavPage {
	title: string;
	path: string;
	type: string;
}
const navFile = "docs/nav.json";
const pageTypes = new Set([
	"guide",
	"concept",
	"recipe",
	"reference",
	"project",
]);
const nav = JSON.parse(readFileSync(resolve(root, navFile), "utf8")) as {
	sections: { title: string; pages: NavPage[] }[];
};
const listed = new Set<string>();
for (const section of nav.sections) {
	for (const page of section.pages) {
		const where = `${navFile}: ${section.title} > ${page.title}`;
		if (!page.title || !page.path)
			problems.push(`${where} (needs a title and a path)`);
		if (!pageTypes.has(page.type))
			problems.push(
				`${where} (type "${page.type}" is not one of ${[...pageTypes].join(", ")})`,
			);
		if (!existsSync(resolve(root, page.path)))
			problems.push(`${where}: ${page.path} (no such file)`);
		if (listed.has(page.path))
			problems.push(`${where}: ${page.path} (listed twice)`);
		listed.add(page.path);
	}
}
for (const page of new Bun.Glob("docs/**/*.md").scanSync(root))
	if (!page.startsWith("docs/plans/") && !listed.has(page))
		problems.push(`${page} (not in ${navFile}: add it to a section)`);

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log(
	`${files.length} files, all relative links resolve; ${navFile} lists ${listed.size} pages, every page of docs/ included.`,
);
