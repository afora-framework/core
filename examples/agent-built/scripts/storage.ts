/**
 * Where a run keeps its data, and the brief it is built from: `memory` (the
 * briefs as written) or `sqlite` (the same brief, whose storage sentence says
 * SQLite, a file named by DATABASE_PATH).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { BriefVersion } from "../eval/invariants.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Db = "memory" | "sqlite";
export const DBS: readonly Db[] = ["memory", "sqlite"];
export const isDb = (value: unknown): value is Db => DBS.includes(value as Db);

/** The file of each version of the brief. */
export const BRIEF_FILES: Readonly<Record<BriefVersion, string>> = {
	1: "BRIEF.v1.md",
	2: "BRIEF.md",
	3: "BRIEF.v3.md",
};

/** The sentence of every brief that says where the data is kept. */
export const MEMORY_SENTENCE = "Data is kept in memory; there is no database.";
export const SQLITE_SENTENCE =
	"Data is kept in a SQLite database: the file named by the environment variable `DATABASE_PATH` (an in-memory database, `:memory:`, when it is not set). The tables are created when the app starts.";

/** The brief a run of `version` on `db` is given, as sent to the model. */
export async function briefText(
	version: BriefVersion,
	db: Db = "memory",
): Promise<string> {
	const text = await readFile(join(ROOT, BRIEF_FILES[version]), "utf8");
	if (db === "memory") return text;
	if (!text.includes(MEMORY_SENTENCE)) {
		throw new Error(
			`${BRIEF_FILES[version]} has no "${MEMORY_SENTENCE}" sentence to replace.`,
		);
	}
	return text.replace(MEMORY_SENTENCE, SQLITE_SENTENCE);
}

/**
 * Writes `src/db.ts` into an afora project on SQLite: it re-exports the
 * database and tables of db/sqlite.ts, which the agent's spec imports.
 */
export async function writeDbModule(project: string): Promise<void> {
	const src = join(project, "src");
	await mkdir(src, { recursive: true });
	let from = relative(src, join(ROOT, "db/sqlite.ts")).replaceAll("\\", "/");
	if (!from.startsWith(".")) from = `./${from}`;
	await writeFile(
		join(src, "db.ts"),
		`// Written by the evaluation harness (db/sqlite.ts), not by the agent.\nexport { db, tables } from ${JSON.stringify(from)};\n`,
	);
}

/** Whether a project has the `src/db.ts` of the harness. */
export const hasDbModule = (project: string): boolean =>
	existsSync(join(project, "src/db.ts"));
