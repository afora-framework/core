/**
 * Type-checks every ```ts / ```typescript block of README.md, docs/** (except
 * docs/plans/** and the generated docs/reference/api.md) and packages/* /README.md
 * (issue #93), in one TypeScript program, so it is fast. Compiler options
 * follow the root tsconfig.json (top-level await allowed). Needs no build.
 *
 * Resolution:
 * - `@afora/core`, `/adapters`, `/experimental` and `/testing` resolve to
 *   `src/`, and `@afora/<pkg>` to `packages/<pkg>/src/index.ts`.
 * - Other bare imports resolve from the root `node_modules`, then from each
 *   `packages/* /node_modules` and from `examples/interop/node_modules`, so a
 *   snippet can import `hono`, `drizzle-orm`, `elysia`, `express`, `fastify`,
 *   `@trpc/server`... as written (run `bun install` in examples/interop once).
 *   A module found nowhere fails the block: skip it, with the reason.
 *
 * Each block is its own module, unless marked. Markers are HTML comments on
 * the line right before the fence:
 *
 *     <!-- docs:code continue -->
 *     <!-- docs:code skip: pseudo code, shows the shape only -->
 *
 * - `continue` appends the block to the previous checked ts block of the same
 *   file, so a page can build up one module across blocks (the continued
 *   block sees the earlier declarations and imports; it does not repeat
 *   them). A `continue` with no checked block before it is a failure.
 * - `skip` leaves the block out; a skip without a reason is a failure.
 *
 *   bun scripts/check-doc-code.ts                         exit 1 on failures
 *   bun scripts/check-doc-code.ts --report --out FILE     exit 0, markdown report in FILE
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	checkVirtualModules,
	entryPoints,
	root,
	type VirtualModule,
} from "../tests/api-surface/program";

const argv = process.argv.slice(2);
const reportOnly = argv.includes("--report");
const outIndex = argv.indexOf("--out");
const outFile = outIndex >= 0 ? argv[outIndex + 1] : undefined;

const files = [
	...new Bun.Glob("README.md").scanSync(root),
	...new Bun.Glob("docs/**/*.md").scanSync(root),
	...new Bun.Glob("packages/*/README.md").scanSync(root),
]
	.filter(
		(file) =>
			!file.startsWith("docs/plans/") && file !== "docs/reference/api.md",
	)
	.sort();

/** One code block of a module: its first line in the module and its fence in the file. */
interface Segment {
	moduleLine: number;
	fenceLine: number;
}
interface Block {
	file: string;
	line: number;
	code: string[];
	segments: Segment[];
}
const blocks: Block[] = [];
const problems: { file: string; line: number; message: string }[] = [];
let skipped = 0;
let continued = 0;
const skipMarker = /^<!--\s*docs:code skip(?::\s*(.*?))?\s*-->\s*$/;
const continueMarker = /^<!--\s*docs:code continue\s*-->\s*$/;

for (const file of files) {
	const lines = readFileSync(join(root, file), "utf8").split("\n");
	let last: Block | undefined;
	for (let i = 0; i < lines.length; i++) {
		const open = /^(\s*)```+\s*(\w*)/.exec(lines[i] as string);
		if (!open) continue;
		const indent = (open[1] as string).length;
		const lang = (open[2] as string).toLowerCase();
		const body: string[] = [];
		let j = i + 1;
		while (j < lines.length && !/^\s*```+\s*$/.test(lines[j] as string)) {
			body.push((lines[j] as string).slice(indent));
			j++;
		}
		const fenceLine = i + 1;
		const previous = (lines[i - 1] ?? "").trim();
		i = j;
		if (lang !== "ts" && lang !== "typescript") continue;
		const skip = skipMarker.exec(previous);
		if (skip) {
			skipped++;
			if (!skip[1])
				problems.push({
					file,
					line: fenceLine,
					message:
						"docs:code skip needs a reason: `<!-- docs:code skip: why -->`",
				});
			continue;
		}
		if (continueMarker.test(previous)) {
			if (!last) {
				problems.push({
					file,
					line: fenceLine,
					message:
						"docs:code continue has no checked ts block before it in this file",
				});
				continue;
			}
			continued++;
			last.segments.push({ moduleLine: last.code.length + 1, fenceLine });
			last.code.push(...body);
			continue;
		}
		last = {
			file,
			line: fenceLine,
			code: [...body],
			segments: [{ moduleLine: 1, fenceLine }],
		};
		blocks.push(last);
	}
}

const byId = new Map<string, Block>();
const modules: VirtualModule[] = blocks.map((block) => {
	const id = `${block.file}:${block.line}`;
	byId.set(id, block);
	return { id, code: block.code.join("\n") };
});

const paths: Record<string, string[]> = Object.fromEntries(
	entryPoints.map((entry) => [entry.specifier, [entry.src]]),
);
const fallbackRoots: string[] = [];
for (const dir of [
	...new Bun.Glob("*/package.json").scanSync(join(root, "packages")),
].sort()) {
	const name = dir.split("/")[0] as string;
	const source = join(root, "packages", name, "src/index.ts");
	if (existsSync(source)) paths[`@afora/${name}`] = [source];
	fallbackRoots.push(join(root, "packages", name));
}
fallbackRoots.push(join(root, "examples/interop"));

const started = performance.now();
const failures = checkVirtualModules(modules, paths, undefined, fallbackRoots);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

/** A diagnostic's line within the module -> line in the markdown file. */
const absolute = (block: Block, diagnostic: string) =>
	diagnostic.replace(/^(\d+):(\d+) /, (_, line) => {
		const at = Number(line);
		let segment = block.segments[0] as Segment;
		for (const candidate of block.segments)
			if (candidate.moduleLine <= at) segment = candidate;
		return `${block.file}:${segment.fenceLine + at - segment.moduleLine + 1} `;
	});

const perFile = new Map<string, number>();
for (const failure of failures) {
	const block = byId.get(failure.id) as Block;
	perFile.set(block.file, (perFile.get(block.file) ?? 0) + 1);
}
for (const problem of problems)
	perFile.set(problem.file, (perFile.get(problem.file) ?? 0) + 1);

const total = failures.length + problems.length;
const summary = `${modules.length} modules (${modules.length + continued} blocks) checked in ${files.length} files (${skipped} skipped) in ${seconds}s: ${total} failing.`;

const lines: string[] = [summary, ""];
for (const problem of problems)
	lines.push(`${problem.file}:${problem.line}  ${problem.message}`);
for (const failure of failures) {
	lines.push(failure.id);
	for (const diagnostic of failure.diagnostics.slice(0, 3))
		lines.push(`    ${absolute(byId.get(failure.id) as Block, diagnostic)}`);
	if (failure.diagnostics.length > 3)
		lines.push(`    ... and ${failure.diagnostics.length - 3} more`);
}
console.log(lines.join("\n"));

if (outFile) {
	const md = [
		"# docs:code report",
		"",
		summary,
		"",
		"## Failing blocks by file",
		"",
		"| File | Failing blocks |",
		"| --- | --- |",
		...[...perFile].sort().map(([file, n]) => `| ${file} | ${n} |`),
		"",
		"## Details",
		"",
		...problems.map((p) => `- \`${p.file}:${p.line}\` ${p.message}`),
		...failures.flatMap((failure) => [
			`### ${failure.id}`,
			"",
			...failure.diagnostics
				.slice(0, 3)
				.map(
					(d) =>
						`- \`${absolute(byId.get(failure.id) as Block, d).replace(/`/g, "'")}\``,
				),
			failure.diagnostics.length > 3
				? `- ... and ${failure.diagnostics.length - 3} more`
				: "",
			"",
		]),
	];
	writeFileSync(outFile, `${md.join("\n")}\n`);
	console.log(
		`\nReport written to ${relative(process.cwd(), outFile) || outFile}`,
	);
}
process.exit(total > 0 && !reportOnly ? 1 : 0);
