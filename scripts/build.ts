/**
 * Builds the JavaScript of `dist`: every module of `src` becomes one module
 * of `dist` at the same path (`src/core/schema/schema.ts` →
 * `dist/core/schema/schema.js`), transpiled and not bundled, next to the
 * declaration `tsc` writes for it. A bundler then keeps only the modules an
 * application imports (the package declares `"sideEffects": false`), and
 * every class, symbol and registry is defined in one file, so it is the same
 * object whichever entry (`.`, `./adapters`, `./experimental`, `./testing`)
 * it comes from. Tests, sandboxes, fixtures and `types/` (declarations only)
 * are left out. Dependencies stay imports.
 *
 * Sources import without an extension, as `bundler` resolution allows; the
 * relative imports get the `.js` (or `/index.js`) that Node requires.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const src = join(root, "src");
const dist = resolve(process.argv[2] ?? join(root, "dist"));

const skipped = /(\.test|\.sandbox|\.fixtures)\.ts$|(^|\/)types\//;
const files = [...new Bun.Glob("**/*.ts").scanSync(src)]
	.filter((file) => !skipped.test(file) && !file.endsWith(".d.ts"))
	.sort();

const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
const specifier =
	/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}(?:\/[^"']*)?)\2/g;

function withExtension(from: string, target: string): string {
	if (/\.[cm]?js$/.test(target)) return target;
	const absolute = resolve(dirname(from), target);
	if (existsSync(`${absolute}.ts`)) return `${target}.js`;
	if (existsSync(join(absolute, "index.ts"))) return `${target}/index.js`;
	throw new Error(`${from}: cannot resolve "${target}"`);
}

let bytes = 0;
for (const file of files) {
	const path = join(src, file);
	const code = transpiler
		.transformSync(await Bun.file(path).text())
		.replace(
			specifier,
			(_, head: string, quote: string, target: string) =>
				`${head}${quote}${withExtension(path, target)}${quote}`,
		);
	const out = join(dist, file.replace(/\.ts$/, ".js"));
	await Bun.write(out, code);
	bytes += code.length;
}

for (const entry of ["index", "adapters", "experimental", "testing/index"]) {
	if (!statSync(join(dist, `${entry}.js`), { throwIfNoEntry: false })) {
		throw new Error(`dist/${entry}.js was not built`);
	}
}
console.log(
	`dist: ${files.length} modules, ${(bytes / 1024).toFixed(1)} KB of JavaScript`,
);
