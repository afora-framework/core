/**
 * Checks that every relative markdown link, and every `#anchor`, in the
 * README, the docs, the package READMEs and the example READMEs resolves. Run: `bun scripts/check-doc-links.ts`.
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

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log(`${files.length} files, all relative links resolve.`);
