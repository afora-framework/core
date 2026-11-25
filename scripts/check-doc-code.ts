/**
 * Checks every code block of README.md, docs/** (except docs/plans/** and the
 * generated docs/reference/api.md) and packages/* /README.md (issue #93). Every
 * fence (of backticks or tildes) names its language, and every block is checked
 * or skipped with a reason:
 *
 * - `ts` / `typescript`: type-checked, all in one TypeScript program (fast).
 *   Compiler options follow the root tsconfig.json (top-level await allowed).
 *   Needs no build.
 * - `json` / `jsonc`: parsed. `json afora` is a whole afora.json, validated
 *   against packages/codegen/afora.schema.json; `json afora:partial` is some
 *   top-level keys of one; `json afora:<key>` (e.g. `afora:useCases`) is some
 *   members of that top-level key. A fragment that starts with `"name":` is read
 *   as the members of an object. A plain `json` block that is an afora.json
 *   must say so.
 * - `bash` / `sh`: not run. Every `bun run <script>` / `npm run <script>` names
 *   a script of the root package.json (or of the package, for its README),
 *   every `@afora/<name>` installed is a package of this repository, and every
 *   `afora-codegen` / `afora-mcp` command and flag is one of the usage text of
 *   packages/codegen/src/cli.ts / packages/mcp/src/bin.ts. `text` blocks are
 *   output, not code; their `afora-codegen` / `afora-mcp` lines are checked too.
 * - `yaml`: parsed.
 *
 * Resolution of ts imports:
 * - `@afora/core`, `/client`, `/adapters`, `/experimental` and `/testing` resolve to
 *   `src/`, and `@afora/<pkg>` to `packages/<pkg>/src/index.ts`.
 * - Other bare imports resolve from the root `node_modules`, then from each
 *   `packages/* /node_modules` and from `examples/interop/node_modules`, so a
 *   snippet can import `hono`, `drizzle-orm`, `elysia`, `express`, `fastify`,
 *   `@trpc/server`... as written (run `bun install` in examples/interop once).
 * - The blocks of a page sit in one directory, so a block named with `file:`
 *   is imported by the others by its relative path.
 *
 * Markers are HTML comments (hidden on GitHub and on the site). A block marker
 * sits on the lines right before the fence (several may stack):
 *
 *     <!-- docs:code skip: why -->            leaves the block out (a reason is required)
 *     <!-- docs:code continue -->             appends the block to the previous checked ts block of the page
 *     <!-- docs:code file: src/db.ts -->      the block is that file of the page
 *     <!-- docs:code tested: examples/x.ts --> the block is in that file, which CI runs
 *     <!-- docs:code expect-error: text -->   the block must fail, every error containing text (after
 *                                             `continue`: a copy of the page's module so far, plus the block)
 *     <!-- docs:code isolated -->             checked in a program of its own (with the files of its
 *                                             page: hidden, generated or named), e.g. a `declare module` that would change
 *                                             the types of every other block
 *     <!-- docs:code context
 *     import { hono } from "@afora/hono";
 *     declare const tenantOf: (host?: string) => string;
 *     -->
 *
 * `context` is hidden code put around the block: before it, or around the line
 * `/* block *\/` when it has one (to check a fragment where it belongs). A
 * block with a context stands alone: a later `continue` goes on from the
 * checked block before it. Hidden code may not hold a `@ts-` directive, and a
 * context may not put the block inside a string, a template or a comment. Page
 * markers can sit anywhere on the page:
 *
 *     <!-- docs:code file: src/api.ts
 *     ...a hidden file of the page...
 *     -->
 *     <!-- docs:code generate[: dir]
 *     { "version": 1, ...an afora.json, its generated files become files of the page }
 *     -->
 *
 * `<!-- docs:code generate[: dir] -->` right before a `json afora` block does the
 * same with the block, and `<!-- docs:code excerpt: dir/src/domain/entities.ts -->`
 * before a ts block checks that its lines (but blank lines and `// ...`) are
 * lines of those generated files (a comma-separated list), in order.
 *
 *   bun scripts/check-doc-code.ts                         exit 1 on failures
 *   bun scripts/check-doc-code.ts --report --out FILE     exit 0, markdown report in FILE
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import ts from "typescript-language-service";
import {
	checkVirtualModules,
	entryPoints,
	root,
	type VirtualModule,
} from "../tests/api-surface/program";

// Imported by path, so the root type check (which runs without dist/) does not
// follow the package sources, whose `@afora/core` resolves to dist/.
const codegenModule = join(root, "packages/codegen/src/index.ts");
const honoModule = join(root, "packages/hono/src/index.ts");
const { generate } = (await import(codegenModule)) as {
	generate: (
		spec: unknown,
		extended: object,
		options: { stages: readonly unknown[] },
	) => readonly { path: string; contents: string }[];
};
const { stages: honoStages } = (await import(honoModule)) as {
	stages: readonly unknown[];
};

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

/** Lines of a module and where they come from in the markdown file. */
interface Segment {
	moduleLine: number;
	/** The markdown line just before the first line of the segment. */
	fenceLine: number;
}
interface TsModule {
	file: string;
	line: number;
	path: string;
	code: string[];
	segments: Segment[];
	expectError?: string;
	hidden?: boolean;
	isolated?: boolean;
}
interface Marker {
	kind: string;
	arg?: string;
	body?: string[];
	line: number;
}

const problems: { file: string; line: number; message: string }[] = [];
const problem = (file: string, line: number, message: string) =>
	problems.push({ file, line, message });
const modules: TsModule[] = [];
const generatedFiles = new Map<string, string>();
const excerpts: {
	file: string;
	line: number;
	paths: string[];
	body: string[];
}[] = [];
const skips = new Map<string, number>();
const count = {
	ts: 0,
	continued: 0,
	tested: 0,
	expectError: 0,
	context: 0,
	jsonSchema: 0,
	jsonParsed: 0,
	shell: 0,
	yaml: 0,
	text: 0,
	generated: 0,
	isolated: 0,
	excerpt: 0,
};

// ---------- afora.json schema ----------
const specSchema = JSON.parse(
	readFileSync(join(root, "packages/codegen/afora.schema.json"), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSpec = ajv.compile(specSchema);
const validatePartial = ajv.compile({ ...specSchema, required: [] });
const keyValidators = new Map<string, ReturnType<typeof ajv.compile>>();
const validatorOf = (kind: string) => {
	if (kind === "afora") return validateSpec;
	if (kind === "afora:partial") return validatePartial;
	const key = kind.slice("afora:".length);
	const property = specSchema.properties[key];
	if (!kind.startsWith("afora:") || !property) return undefined;
	let validate = keyValidators.get(key);
	if (!validate) {
		validate = ajv.compile({
			$schema: specSchema.$schema,
			$defs: specSchema.$defs,
			...property,
		});
		keyValidators.set(key, validate);
	}
	return validate;
};
const specKeys = new Set(
	Object.keys(specSchema.properties).filter((key) => key !== "$schema"),
);
const looksLikeSpec = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	((typeof (value as { $schema?: unknown }).$schema === "string" &&
		(value as { $schema: string }).$schema.includes("afora.schema")) ||
		("version" in value &&
			Object.keys(value).some(
				(key) => key !== "version" && specKeys.has(key),
			)));

// ---------- the CLIs ----------
interface Cli {
	commands: { words: string[]; flags: Set<string> }[];
}
const usageOf = (path: string) => {
	const source = readFileSync(join(root, path), "utf8");
	const usage = /const USAGE = `([\s\S]*?)`;/.exec(source)?.[1];
	if (!usage) throw new Error(`no USAGE text in ${path}`);
	return usage;
};
const cliOf = (path: string, bin: string): Cli => {
	const commands: Cli["commands"] = [];
	for (const line of usageOf(path).split("\n")) {
		const at = line.indexOf(`${bin} `);
		if (at < 0 || !/^\s*(Usage:\s*)?$/.test(line.slice(0, at))) continue;
		const tokens = line
			.slice(at + bin.length)
			.trim()
			.split(/\s+/);
		const words: string[] = [];
		for (const token of tokens) {
			if (!/^[a-z]+$/.test(token)) break;
			words.push(token);
		}
		commands.push({
			words,
			flags: new Set(line.match(/--[a-z][a-z-]*/g) ?? []),
		});
	}
	return { commands };
};
const clis: Record<string, Cli> = {
	"afora-codegen": cliOf("packages/codegen/src/cli.ts", "afora-codegen"),
	"afora-mcp": cliOf("packages/mcp/src/bin.ts", "afora-mcp"),
};
const binOf = (token: string, previous: string | undefined) => {
	if (token === "afora-codegen" || token === "afora-mcp") return token;
	if (
		(token === "@afora/codegen" || token === "@afora/mcp") &&
		(previous === "bunx" || previous === "npx" || previous === "x")
	)
		return token === "@afora/codegen" ? "afora-codegen" : "afora-mcp";
	return undefined;
};

const scriptsOf = (path: string) =>
	Object.keys(JSON.parse(readFileSync(path, "utf8")).scripts ?? {});
const rootScripts = scriptsOf(join(root, "package.json"));
const packageNames = new Set<string>(["@afora/core"]);
for (const dir of new Bun.Glob("*/package.json").scanSync(
	join(root, "packages"),
))
	packageNames.add(
		JSON.parse(readFileSync(join(root, "packages", dir), "utf8")).name,
	);

/**
 * Splits shell text into commands: at `&&`, `||`, `|`, `;`, `$(`, `>` and
 * comments (whose text may hold the alternative command, `# or: npm ...`).
 */
const commandsOf = (text: string) =>
	text
		.replace(/\\\n/g, " ")
		.split(/\n|&&|\|\||\||;|\$\(|\)|(?:^|\s)#(?:\s*or:)?|\s>\s?/)
		.map((part) =>
			part
				.trim()
				.split(/\s+/)
				.map((token) => token.replace(/^\[/, "").replace(/\](\.\.\.)?$/, ""))
				.filter(Boolean),
		)
		.filter((tokens) => tokens.length > 0);

function checkShell(
	file: string,
	line: number,
	text: string,
	cliOnly: boolean,
) {
	const pkg = /^packages\/([^/]+)\/README\.md$/.exec(file)?.[1];
	const scripts = new Set(rootScripts);
	if (pkg)
		for (const name of scriptsOf(join(root, "packages", pkg, "package.json")))
			scripts.add(name);
	for (const tokens of commandsOf(text)) {
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			const bin = binOf(token, tokens[i - 1]);
			if (bin) {
				checkCli(file, line, bin, tokens.slice(i + 1));
				break;
			}
			if (cliOnly) continue;
			const runner = tokens[i - 1] ?? "";
			if (token === "run" && ["bun", "npm", "pnpm", "yarn"].includes(runner)) {
				const script = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
				if (script && !scripts.has(script))
					problem(
						file,
						line,
						`\`${runner} run ${script}\`: no such script in ${pkg ? `package.json or packages/${pkg}/package.json` : "package.json"}`,
					);
				break;
			}
			if (
				(token === "add" && runner === "bun") ||
				((token === "install" || token === "i") && runner === "npm")
			) {
				for (const name of tokens.slice(i + 1))
					if (
						name.startsWith("@afora/") &&
						!packageNames.has(name.replace(/(.)@[^/]*$/, "$1"))
					)
						problem(
							file,
							line,
							`\`${name}\` is not a package of this repository`,
						);
				break;
			}
		}
	}
}

function checkCli(file: string, line: number, bin: string, args: string[]) {
	const cli = clis[bin] as Cli;
	// no command, --help and -h print the usage
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return;
	const command = cli.commands
		.filter((candidate) =>
			candidate.words.every((word, index) => args[index] === word),
		)
		.sort((a, b) => b.words.length - a.words.length)[0];
	if (!command) {
		problem(
			file,
			line,
			`\`${bin} ${args.slice(0, 2).join(" ")}\`: no such command in the usage of ${bin}`,
		);
		return;
	}
	for (const option of args.filter((arg) => arg.startsWith("-"))) {
		const name = option.split("=")[0] as string;
		if (name === "--help" || name === "-h") continue;
		if (!command.flags.has(name))
			problem(
				file,
				line,
				`\`${[bin, ...command.words].join(" ")}\` has no ${name} flag in its usage`,
			);
	}
}

// ---------- reading the pages ----------
const blockKinds = new Set([
	"skip",
	"continue",
	"file",
	"tested",
	"expect-error",
	"context",
	"isolated",
	"generate",
	"excerpt",
]);
const slugOf = (file: string) => file.replace(/\.md$/, "").replace(/\//g, "__");

for (const file of files) {
	const lines = readFileSync(join(root, file), "utf8").split("\n");
	const slug = slugOf(file);
	let last: TsModule | undefined;
	let pending: Marker[] = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i] as string;
		const marker =
			/^\s*<!--\s*docs:code\s+([a-z-]+)(?::\s*(.*?))?\s*(-->)?\s*$/.exec(text);
		if (marker) {
			const kind = marker[1] as string;
			const found: Marker = { kind, line: i + 1 };
			if (marker[2]) found.arg = marker[2];
			if (!marker[3]) {
				const body: string[] = [];
				let j = i + 1;
				let unclosed = false;
				while (j < lines.length && (lines[j] as string).trim() !== "-->") {
					const line = lines[j] as string;
					// a fence, another comment or a `-->` that is not alone: the comment was left open
					if (/^\s*(`{3,}|~{3,}|<!--)/.test(line) || line.includes("-->")) {
						unclosed = true;
						break;
					}
					body.push(line);
					j++;
				}
				if (unclosed || j >= lines.length) {
					problem(
						file,
						i + 1,
						`docs:code ${kind} is not closed: end it with a line holding only \`-->\`${j < lines.length ? ` (line ${j + 1} comes first)` : ""}`,
					);
					pending = [];
					continue;
				}
				// 6: hidden code cannot turn the checker off
				const directive = body.findIndex((line) => /@ts-/.test(line));
				if (directive >= 0)
					problem(
						file,
						i + 2 + directive,
						"hidden code may not hold a `@ts-` directive",
					);
				found.body = body;
				i = j;
			}
			if (kind === "generate" && found.body) pageGenerate(file, slug, found);
			else if (kind === "file" && found.body)
				modules.push({
					file,
					line: found.line,
					path: `${slug}/${found.arg}`,
					code: found.body,
					segments: [{ moduleLine: 1, fenceLine: found.line }],
					hidden: true,
				});
			else if (blockKinds.has(kind)) pending.push(found);
			else problem(file, i + 1, `unknown docs:code marker \`${kind}\``);
			continue;
		}
		const open = /^(\s*)(`{3,}|~{3,})\s*(.*?)\s*$/.exec(text);
		if (!open) {
			if (pending.length > 0 && text.trim() !== "") {
				problem(
					file,
					(pending[0] as Marker).line,
					"docs:code marker is not right before a fence",
				);
				pending = [];
			}
			continue;
		}
		const markers = pending;
		pending = [];
		const indent = (open[1] as string).length;
		const info = (open[3] as string).split(/\s+/).filter(Boolean);
		const lang = (info[0] ?? "").toLowerCase();
		const body: string[] = [];
		let j = i + 1;
		const fence = open[2] as string;
		const close = new RegExp(
			`^\\s*${fence[0] === "~" ? "~" : "`"}{${fence.length},}\\s*$`,
		);
		while (j < lines.length && !close.test(lines[j] as string)) {
			body.push((lines[j] as string).slice(indent));
			j++;
		}
		const fenceLine = i + 1;
		i = j;
		const get = (kind: string) => markers.find((m) => m.kind === kind);

		const skip = get("skip");
		if (skip) {
			if (!skip.arg)
				problem(
					file,
					fenceLine,
					"docs:code skip needs a reason: `<!-- docs:code skip: why -->`",
				);
			else skips.set(skip.arg, (skips.get(skip.arg) ?? 0) + 1);
			if (markers.length > 1)
				problem(file, fenceLine, "docs:code skip goes alone");
			continue;
		}
		if (lang === "") {
			problem(
				file,
				fenceLine,
				"the fence names no language: `text` for output, or the language of the code",
			);
			continue;
		}
		const isTs = lang === "ts" || lang === "typescript";
		const generateMarker = get("generate");
		if (generateMarker && !(lang === "json" || lang === "jsonc")) {
			problem(file, fenceLine, "docs:code generate is for json afora blocks");
			continue;
		}
		const tsOnly = markers.filter(
			(m) => m.kind !== "tested" && m.kind !== "generate",
		);
		if (!isTs && tsOnly.length > 0) {
			problem(
				file,
				fenceLine,
				`docs:code ${(tsOnly[0] as Marker).kind} is for ts blocks`,
			);
			continue;
		}
		const tested = get("tested");
		if (tested) {
			checkTested(file, fenceLine, tested, body);
			continue;
		}
		const excerpt = get("excerpt");
		if (isTs && excerpt) {
			if (markers.length > 1)
				problem(file, fenceLine, "docs:code excerpt goes alone");
			excerpts.push({
				file,
				line: fenceLine,
				paths: (excerpt.arg ?? "")
					.split(",")
					.map((path) => `${slug}/${path.trim()}`),
				body,
			});
			continue;
		}
		if (isTs) {
			const context = get("context");
			const before: string[] = [];
			const after: string[] = [];
			if (context) {
				count.context++;
				const lines = context.body ?? [];
				if (!context.body)
					problem(
						file,
						context.line,
						"docs:code context holds its code on the lines after it",
					);
				const at = lines.findIndex((l) => l.trim() === "/* block */");
				before.push(...(at < 0 ? lines : lines.slice(0, at)));
				if (at >= 0) after.push(...lines.slice(at + 1));
				if (!blockIsCode(before, after))
					problem(
						file,
						context.line,
						"docs:code context puts the block inside a string or a comment",
					);
			}
			const append = (target: TsModule) => {
				const contextLine = context?.line ?? fenceLine;
				if (before.length > 0) {
					target.segments.push({
						moduleLine: target.code.length + 1,
						fenceLine: contextLine,
					});
					target.code.push(...before);
				}
				target.segments.push({
					moduleLine: target.code.length + 1,
					fenceLine,
				});
				target.code.push(...body);
				if (after.length > 0) {
					target.segments.push({
						moduleLine: target.code.length + 1,
						fenceLine: contextLine + before.length + 1,
					});
					target.code.push(...after);
				}
			};
			if (get("continue")) {
				if (!last) {
					problem(
						file,
						fenceLine,
						"docs:code continue has no checked ts block before it in this file",
					);
					continue;
				}
				const expectError = get("expect-error");
				if (expectError) {
					// A wrong block that builds on the page: a copy of the module so far, plus the block.
					count.expectError++;
					const copy: TsModule = {
						file,
						line: fenceLine,
						path: `${slug}/L${fenceLine}.ts`,
						code: [...last.code],
						segments: [...last.segments],
						expectError: expectError.arg ?? "",
					};
					if (!expectError.arg)
						problem(
							file,
							fenceLine,
							"docs:code expect-error needs the text of the error",
						);
					append(copy);
					modules.push(copy);
					continue;
				}
				count.continued++;
				append(last);
				continue;
			}
			count.ts++;
			const named = get("file");
			const expectError = get("expect-error");
			const module: TsModule = {
				file,
				line: fenceLine,
				path: `${slug}/${named?.arg ?? `L${fenceLine}.ts`}`,
				code: [],
				segments: [],
			};
			append(module);
			modules.push(module);
			if (get("isolated")) {
				module.isolated = true;
				count.isolated++;
			}
			if (expectError) {
				if (!expectError.arg)
					problem(
						file,
						fenceLine,
						"docs:code expect-error needs the text of the error",
					);
				module.expectError = expectError.arg ?? "";
				count.expectError++; // a wrong block is not built on
			} else if (!context) last = module; // a block with a context stands alone
			continue;
		}
		if (lang === "json" || lang === "jsonc") {
			const spec = checkJson(file, fenceLine, lang, info[1], body.join("\n"));
			if (generateMarker) {
				if (info[1] !== "afora")
					problem(
						file,
						fenceLine,
						"docs:code generate needs a whole afora.json (`json afora`)",
					);
				else if (spec !== undefined)
					generateFrom(file, slug, spec, generateMarker);
			}
			continue;
		}
		if (lang === "bash" || lang === "sh" || lang === "shell") {
			count.shell++;
			checkShell(file, fenceLine, body.join("\n"), false);
			continue;
		}
		if (lang === "text") {
			count.text++;
			checkShell(file, fenceLine, body.join("\n"), true);
			continue;
		}
		if (lang === "yaml" || lang === "yml") {
			count.yaml++;
			try {
				Bun.YAML.parse(body.join("\n"));
			} catch (error) {
				problem(
					file,
					fenceLine,
					`yaml does not parse: ${(error as Error).message}`,
				);
			}
			continue;
		}
		problem(
			file,
			fenceLine,
			`no check for \`${lang}\` blocks: skip it with a reason`,
		);
	}
	if (pending.length > 0)
		problem(
			file,
			(pending[0] as Marker).line,
			"docs:code marker is not right before a fence",
		);
}

/**
 * Whether the block lands in code: with an identifier in its place, the
 * context parses to a module holding that identifier (not inside a string,
 * a template or a comment, where the block would not be checked).
 */
function blockIsCode(before: string[], after: string[]): boolean {
	const name = "__docs_code_block__";
	const source = ts.createSourceFile(
		"context.ts",
		[...before, name, ...after].join("\n"),
		ts.ScriptTarget.Latest,
		true,
	);
	let found = false;
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && node.text === name) found = true;
		else ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function checkTested(
	file: string,
	line: number,
	marker: Marker,
	body: string[],
) {
	const path = marker.arg ?? "";
	if (!path.startsWith("examples/")) {
		problem(
			file,
			line,
			"docs:code tested names a file of examples/, which CI runs",
		);
		return;
	}
	if (!existsSync(join(root, path))) {
		problem(file, line, `docs:code tested: ${path} does not exist`);
		return;
	}
	const normalize = (text: string) =>
		text
			.split("\n")
			.map((l) => l.trimEnd())
			.join("\n")
			.trim();
	if (
		!normalize(readFileSync(join(root, path), "utf8")).includes(
			normalize(body.join("\n")),
		)
	)
		problem(file, line, `the block is not in ${path} as written`);
	else count.tested++;
}

function checkJson(
	file: string,
	line: number,
	lang: string,
	kind: string | undefined,
	text: string,
): unknown {
	const parse = (source: string): unknown =>
		lang === "jsonc" ? Bun.JSONC.parse(source) : JSON.parse(source);
	if (kind !== undefined) {
		const validate = validatorOf(kind);
		if (!validate) {
			problem(
				file,
				line,
				`\`${kind}\`: the kind is \`afora\`, \`afora:partial\` or \`afora:<a top-level key of afora.json>\``,
			);
			return;
		}
		let value: unknown;
		try {
			value = parse(text.trimStart().startsWith('"') ? `{${text}}` : text);
		} catch (error) {
			problem(
				file,
				line,
				`${lang} does not parse: ${(error as Error).message}`,
			);
			return;
		}
		if (!validate(value)) {
			for (const error of (validate.errors ?? []).slice(0, 3)) {
				const extra =
					"additionalProperty" in error.params
						? ` (${error.params.additionalProperty})`
						: "";
				problem(
					file,
					line,
					`not valid as ${kind}: ${error.instancePath || "/"} ${error.message}${extra}`,
				);
			}
			return;
		}
		count.jsonSchema++;
		return value;
	}
	let value: unknown;
	try {
		value = parse(text);
	} catch (error) {
		const hint = text.trimStart().startsWith('"')
			? " (a fragment of afora.json? declare its kind: ```json afora:<key>)"
			: "";
		problem(
			file,
			line,
			`${lang} does not parse: ${(error as Error).message}${hint}`,
		);
		return;
	}
	if (looksLikeSpec(value)) {
		problem(
			file,
			line,
			`an afora.json: mark the fence \`${lang} afora\` so it is validated against the schema`,
		);
		return;
	}
	count.jsonParsed++;
}

function pageGenerate(file: string, slug: string, marker: Marker) {
	let spec: unknown;
	try {
		spec = JSON.parse((marker.body ?? []).join("\n"));
	} catch (error) {
		problem(
			file,
			marker.line,
			`docs:code generate: the spec does not parse: ${(error as Error).message}`,
		);
		return;
	}
	if (!validateSpec(spec)) {
		problem(
			file,
			marker.line,
			`docs:code generate: not a valid afora.json: ${ajv.errorsText(validateSpec.errors)}`,
		);
		return;
	}
	generateFrom(file, slug, spec, marker);
}

/** The files `afora-codegen generate` writes for `spec`, as hidden files of the page (under the directory of the marker, if any). */
function generateFrom(
	file: string,
	slug: string,
	spec: unknown,
	marker: Marker,
) {
	const dir = marker.arg ? `${slug}/${marker.arg}` : slug;
	try {
		const generated = generate(spec, {}, { stages: honoStages });
		for (const output of generated) {
			if (!output.path.endsWith(".ts")) continue;
			count.generated++;
			generatedFiles.set(`${dir}/${output.path}`, output.contents);
			modules.push({
				file,
				line: marker.line,
				path: `${dir}/${output.path}`,
				code: output.contents.split("\n"),
				segments: [{ moduleLine: 1, fenceLine: marker.line }],
				hidden: true,
			});
		}
	} catch (error) {
		problem(
			file,
			marker.line,
			`docs:code generate: ${(error as Error).message}`,
		);
	}
}

// ---------- excerpts of generated files ----------
// Each line of the excerpt (but blank lines and `// ...`) is a line of the files, in order.
for (const excerpt of excerpts) {
	const missing = excerpt.paths.filter((path) => !generatedFiles.has(path));
	if (missing.length > 0) {
		problem(
			excerpt.file,
			excerpt.line,
			`docs:code excerpt: no generated ${missing.map((p) => p.split("/").slice(1).join("/")).join(", ")} on the page before it`,
		);
		continue;
	}
	const lines = excerpt.paths.flatMap((path) =>
		(generatedFiles.get(path) as string).split("\n").map((l) => l.trim()),
	);
	let at = 0;
	let wrong: string | undefined;
	for (const line of excerpt.body.map((l) => l.trim())) {
		if (line === "" || /^\/\/\s*\.\.\./.test(line)) continue;
		const found = lines.indexOf(line, at);
		if (found < 0) {
			wrong = line;
			break;
		}
		at = found + 1;
	}
	if (wrong !== undefined)
		problem(
			excerpt.file,
			excerpt.line,
			`docs:code excerpt: \`${wrong}\` is not what afora-codegen generates there (in that order)`,
		);
	else count.excerpt++;
}

// ---------- type-checking ----------
// A block named as a file takes the place of a hidden or generated file at the same path.
const byPath = new Map<string, TsModule>();
for (const module of modules) {
	const existing = byPath.get(module.path);
	if (existing && !existing.hidden && !module.hidden)
		problem(
			module.file,
			module.line,
			`two blocks are ${module.path.split("/").slice(1).join("/")}`,
		);
	if (!existing || existing.hidden) byPath.set(module.path, module);
}
const byId = new Map<string, TsModule>();
const toVirtual = (module: TsModule): VirtualModule => {
	const id = `${module.file}:${module.line}${module.hidden ? ` (${module.path.split("/").slice(1).join("/")})` : ""}`;
	byId.set(id, module);
	return { id, code: module.code.join("\n"), path: module.path };
};
const all = [...byPath.values()];
const virtual = all.filter((module) => !module.isolated).map(toVirtual);
// An isolated block gets a program of its own, with the files of its page
// (hidden, generated or named with `file:`).
const isolatedPrograms = all
	.filter((module) => module.isolated)
	.map((module) => [
		toVirtual(module),
		...all
			.filter(
				(other) =>
					other !== module &&
					other.file === module.file &&
					!other.isolated &&
					(other.hidden || !/\/L\d+\.ts$/.test(other.path)),
			)
			.map((other) => ({
				id: `${other.file}:${other.line} (isolated)`,
				code: other.code.join("\n"),
				path: other.path,
			})),
	]);

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
const diagnostics = new Map(
	[virtual, ...isolatedPrograms].flatMap((program) =>
		checkVirtualModules(program, paths, undefined, fallbackRoots).map(
			(failure) => [failure.id, failure.diagnostics] as const,
		),
	),
);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

const failures: { id: string; diagnostics: string[] }[] = [];
for (const [id, module] of byId) {
	const found = diagnostics.get(id) ?? [];
	const expected = module.expectError;
	if (expected === undefined) {
		if (found.length > 0) failures.push({ id, diagnostics: found });
	} else if (found.length === 0) {
		failures.push({
			id,
			diagnostics: [`expected an error containing "${expected}", got none`],
		});
	} else if (!found.every((d) => d.includes(expected))) {
		failures.push({
			id,
			diagnostics: found.filter((d) => !d.includes(expected)),
		});
	}
}

/** A diagnostic's line within the module -> line in the markdown file. */
const absolute = (module: TsModule, diagnostic: string) =>
	diagnostic.replace(/^(\d+):(\d+) /, (_, line) => {
		const at = Number(line);
		let segment = module.segments[0] as Segment;
		for (const candidate of module.segments)
			if (candidate.moduleLine <= at) segment = candidate;
		return `${module.file}:${segment.fenceLine + at - segment.moduleLine + 1} `;
	});

const perFile = new Map<string, number>();
for (const failure of failures) {
	const module = byId.get(failure.id) as TsModule;
	perFile.set(module.file, (perFile.get(module.file) ?? 0) + 1);
}
for (const p of problems) perFile.set(p.file, (perFile.get(p.file) ?? 0) + 1);

const skipped = [...skips.values()].reduce((a, b) => a + b, 0);
const total = failures.length + problems.length;
const summary = [
	`${files.length} files in ${seconds}s: ${total} failing.`,
	`ts: ${count.ts + count.continued} blocks type-checked as ${count.ts} modules (${count.context} with a hidden context, ${count.expectError} expected to fail, ${count.isolated} isolated, beside ${count.generated} generated files), ${count.tested} in a tested file of examples/, ${count.excerpt} excerpts of generated files.`,
	`json: ${count.jsonSchema} validated against afora.schema.json, ${count.jsonParsed} parsed. shell: ${count.shell} checked. yaml: ${count.yaml} parsed. text: ${count.text} (output).`,
	`skipped: ${skipped}${[...skips].map(([reason, n]) => `\n  ${n} x ${reason}`).join("")}`,
].join("\n");

const out: string[] = [summary, ""];
for (const p of problems) out.push(`${p.file}:${p.line}  ${p.message}`);
for (const failure of failures) {
	out.push(failure.id);
	for (const d of failure.diagnostics.slice(0, 3))
		out.push(`    ${absolute(byId.get(failure.id) as TsModule, d)}`);
	if (failure.diagnostics.length > 3)
		out.push(`    ... and ${failure.diagnostics.length - 3} more`);
}
console.log(out.join("\n"));

if (outFile) {
	const md = [
		"# docs:code report",
		"",
		"```text",
		summary,
		"```",
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
						`- \`${absolute(byId.get(failure.id) as TsModule, d).replace(/`/g, "'")}\``,
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
