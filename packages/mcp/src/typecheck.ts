import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { run } from "./process";

export interface Diagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly code: string;
	readonly message: string;
}

export type TypecheckResult =
	| {
			readonly ran: true;
			/** No diagnostic in the generated files. */
			readonly ok: boolean;
			/** Only the diagnostics of generated files are listed. */
			readonly diagnostics: readonly Diagnostic[];
			/** How many errors the rest of the project has (not listed). */
			readonly otherErrors: number;
	  }
	| { readonly ran: false; readonly reason: string };

/**
 * The `(line,col): error TSxxxx: ` of a diagnostic line, whose path is what
 * comes before it and message what comes after. Not anchored: a lazy `^(.+?)`
 * before it backtracks in quadratic time on a line that repeats the pattern.
 */
const DIAGNOSTIC = /\((\d+),(\d+)\): error (TS\d+): /;

/** A quoted name tsc prints that is only a name: `'ServiceFactory'`, `'Kind'`. */
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * `text` with each string and template literal as `"…"` (`\`…\``), one
 * that does not close redacted to the end. A single walk: a regular
 * expression with escapes retries from every quote, quadratic on `"\"\"\"…`.
 */
function redactLiterals(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index] as string;
		if (char !== '"' && char !== "`") {
			out += char;
			index++;
			continue;
		}
		let end = index + 1;
		while (end < text.length && text[end] !== char) {
			end += text[end] === "\\" ? 2 : 1;
		}
		out += `${char}…${end < text.length ? char : ""}`;
		index = end + 1;
	}
	return out;
}

/**
 * A tsc message without the values it may print: a type of a project module
 * written `as const` holds its literal values, and tsc quotes it whole. Every
 * literal becomes `"…"`, and every quoted type that is not a plain name
 * becomes `'…'`, so a diagnostic says where and what kind of error, never
 * what a module holds.
 */
export function redactMessage(message: string): string {
	return redactLiterals(message).replace(
		/'([^'\n]*)'/g,
		(quoted, inner: string) => (NAME.test(inner) ? quoted : "'…'"),
	);
}

/** Parses the output of `tsc --noEmit` (default, non-pretty format). */
export function parseDiagnostics(
	output: string,
): (Diagnostic & { readonly path: string })[] {
	const found: (Diagnostic & { path: string })[] = [];
	for (const text of output.split(/\r?\n/)) {
		const match = DIAGNOSTIC.exec(text);
		if (match && match.index > 0) {
			const path = text.slice(0, match.index);
			found.push({
				path,
				file: path,
				line: Number(match[1]),
				column: Number(match[2]),
				code: match[3] as string,
				message: redactMessage(text.slice(match.index + match[0].length)),
			});
		} else if (/^\s+\S/.test(text) && found.length > 0) {
			const last = found[found.length - 1] as { message: string };
			last.message += `\n${redactMessage(text.trim())}`;
		}
	}
	return found;
}

/**
 * Runs `tsc --noEmit -p <root>` when the project has a tsconfig.json, and
 * keeps only the diagnostics of `files` (paths relative to `root`).
 */
export async function typecheck(
	root: string,
	files: readonly string[],
): Promise<TypecheckResult> {
	if (!existsSync(join(root, "tsconfig.json"))) {
		return { ran: false, reason: "The project has no tsconfig.json." };
	}
	const mine = new Set(files.map((file) => resolve(root, file)));
	const commands: [string, string[]][] = [
		// Never install: `bunx tsc` without TypeScript in the project would
		// download and run the unrelated `tsc` package of the registry.
		["bunx", ["--no-install", "tsc", "--noEmit", "-p", root]],
		["npx", ["--no-install", "tsc", "--noEmit", "-p", root]],
	];
	for (const [command, args] of commands) {
		const result = await run(command, args, { cwd: root, timeoutMs: 180_000 });
		if (result.missing) continue;
		if (result.timedOut) {
			return { ran: false, reason: "tsc timed out after 180 seconds." };
		}
		const all = parseDiagnostics(result.output);
		if (all.length === 0 && result.code !== 0) {
			return {
				ran: false,
				reason: `tsc failed without diagnostics: ${redactMessage(result.output.trim().slice(0, 500))}`,
			};
		}
		const diagnostics = all
			.filter((item) => mine.has(resolve(root, item.path)))
			.map(({ path, ...item }) => ({
				...item,
				file: relative(root, resolve(root, path)),
			}));
		return {
			ran: true,
			ok: diagnostics.length === 0,
			diagnostics,
			otherErrors: all.length - diagnostics.length,
		};
	}
	return {
		ran: false,
		reason: "Neither bunx nor npx is available to run tsc.",
	};
}
