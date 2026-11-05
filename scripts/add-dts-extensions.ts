/**
 * Gives the relative imports of the declarations in `dist` the `.js` extension
 * nodenext consumers require. Sources import without one, as `bundler`
 * resolution allows, and `tsc` copies the specifiers as they are. Runs after
 * `bun run build` (as its `postbuild`). Takes the directory to fix as an
 * argument (`dist` of the repository by default), which the packages use too.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? resolve(import.meta.dir, "../dist"));

// Scratch scripts and tests must never ship.
const leaked = [...new Bun.Glob("**/*.{sandbox,test}.*").scanSync(dist)].sort();
if (leaked.length > 0) {
	console.error(
		`dist must not include sandbox or test files:\n${leaked.join("\n")}`,
	);
	process.exit(1);
}

const specifier = /(\bfrom\s+|\bimport\(\s*)(["'])(\.{1,2}(?:\/[^"']*)?)\2/g;

for (const file of new Bun.Glob("**/*.d.ts").scanSync(dist)) {
	const path = join(dist, file);
	const source = await Bun.file(path).text();
	const resolved = source.replace(
		specifier,
		(match, head: string, quote: string, target: string) => {
			if (/\.[cm]?js$/.test(target)) return match;
			const absolute = resolve(dirname(path), target);
			const extension = existsSync(`${absolute}.d.ts`) ? ".js" : "/index.js";
			return `${head}${quote}${target}${extension}${quote}`;
		},
	);
	if (resolved !== source) await Bun.write(path, resolved);
}
