/**
 * Type-checks every ```ts / ```typescript block of README.md, docs/** (except
 * docs/plans/** and the generated docs/reference/api.md) and packages/* /README.md
 * (issue #93). Each block is its own module (top-level await allowed) in one
 * TypeScript program, so it is fast. `@afora/core`, `/adapters`,
 * `/experimental` and `/testing` resolve to `src/`; `@afora/<pkg>` to
 * `packages/<pkg>/src/index.ts`; other bare imports from `node_modules`.
 * Compiler options follow the root tsconfig.json. Needs no build.
 *
 * Opt out of a block with an HTML comment on the line right before the
 * fence, with a reason (a skip without one is itself a failure):
 *
 *     <!-- docs:code skip: pseudo code, shows the shape only -->
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

interface Block {
	file: string;
	line: number;
}
const modules: VirtualModule[] = [];
const blocks = new Map<string, Block>();
const problems: { file: string; line: number; message: string }[] = [];
let skipped = 0;
const skipMarker = /^<!--\s*docs:code skip(?::\s*(.*?))?\s*-->\s*$/;

for (const file of files) {
	const lines = readFileSync(join(root, file), "utf8").split("\n");
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
		const id = `${file}:${fenceLine}`;
		modules.push({ id, code: body.join("\n") });
		blocks.set(id, { file, line: fenceLine });
	}
}

const paths: Record<string, string[]> = Object.fromEntries(
	entryPoints.map((entry) => [entry.specifier, [entry.src]]),
);
for (const dir of new Bun.Glob("*/package.json").scanSync(
	join(root, "packages"),
)) {
	const name = dir.split("/")[0] as string;
	const source = join(root, "packages", name, "src/index.ts");
	if (existsSync(source)) paths[`@afora/${name}`] = [source];
}

const started = performance.now();
const failures = checkVirtualModules(modules, paths);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

/** A diagnostic's line within the block -> line in the markdown file. */
const absolute = (block: Block, diagnostic: string) =>
	diagnostic.replace(
		/^(\d+):(\d+) /,
		(_, line) => `${block.file}:${block.line + Number(line)} `,
	);

const perFile = new Map<string, number>();
for (const failure of failures) {
	const block = blocks.get(failure.id) as Block;
	perFile.set(block.file, (perFile.get(block.file) ?? 0) + 1);
}
for (const problem of problems)
	perFile.set(problem.file, (perFile.get(problem.file) ?? 0) + 1);

const total = failures.length + problems.length;
const summary = `${modules.length} blocks checked in ${files.length} files (${skipped} skipped) in ${seconds}s: ${total} failing.`;

const lines: string[] = [summary, ""];
for (const problem of problems)
	lines.push(`${problem.file}:${problem.line}  ${problem.message}`);
for (const failure of failures) {
	lines.push(failure.id);
	for (const diagnostic of failure.diagnostics.slice(0, 3))
		lines.push(`    ${absolute(blocks.get(failure.id) as Block, diagnostic)}`);
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
						`- \`${absolute(blocks.get(failure.id) as Block, d).replace(/`/g, "'")}\``,
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
