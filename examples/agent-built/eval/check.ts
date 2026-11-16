/**
 * Evaluates one implementation in its own process and prints the evaluation
 * as JSON, so runs never share module state:
 *
 *   bun eval/check.ts afora <project dir> [brief] [db]   # imports <dir>/src/domain, starts App, builds its Hono output
 *   bun eval/check.ts baseline <app.ts> [brief] [db]     # imports the app (default export or `app`)
 *
 * `brief` is the version of the brief the run is checked against (2 by
 * default), `db` where it keeps its data (`memory` by default). JWT_SECRET is
 * set before the implementation loads, as the brief asks for; on `sqlite`,
 * DATABASE_PATH is the file the caller gives (`:memory:` when unset), and an
 * afora run gets its tables from db/sqlite.ts before it starts.
 */
import { join, resolve } from "node:path";
import {
	type BriefVersion,
	CURRENT_BRIEF,
	EVAL_JWT_SECRET,
	evaluate,
	type Handler,
	isBriefVersion,
} from "./invariants.ts";

process.env.JWT_SECRET = EVAL_JWT_SECRET;

interface Fetcher {
	fetch: Handler;
}
const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Fetcher).fetch === "function";

/** The Hono app of the first output of an afora application that builds one. */
async function aforaHandler(project: string, db: string): Promise<Handler> {
	const domain = await import(resolve(join(project, "src/domain/index.ts")));
	const App = domain.App;
	if (!App) throw new Error("src/domain exports no App.");
	if (db === "sqlite") {
		const { prepareSqlite } = await import("../db/sqlite.ts");
		prepareSqlite(App);
	}
	await App.start();
	for (const output of Object.values(App.outputs ?? {})) {
		const built = (output as { build?: () => unknown }).build?.();
		if (isFetcher(built)) return (request) => built.fetch(request);
	}
	throw new Error("No output of App builds an HTTP app.");
}

/** The default export, or the `app` export, of a hand-written module. */
async function baselineHandler(file: string): Promise<Handler> {
	const module = await import(resolve(file));
	for (const candidate of [module.default, module.app]) {
		if (isFetcher(candidate)) return (request) => candidate.fetch(request);
	}
	throw new Error(`${file} exports no app with a fetch method.`);
}

const [kind, target, version, db = "memory"] = Bun.argv.slice(2);
if ((kind !== "afora" && kind !== "baseline") || !target) {
	throw new Error(
		"Usage: bun eval/check.ts afora|baseline <path> [brief] [memory|sqlite]",
	);
}
const brief = (version ? Number(version) : CURRENT_BRIEF) as BriefVersion;
if (!isBriefVersion(brief)) throw new Error("brief must be 1, 2 or 3");
if (db !== "memory" && db !== "sqlite") {
	throw new Error("db must be memory or sqlite");
}
const handler =
	kind === "afora"
		? await aforaHandler(target, db)
		: await baselineHandler(target);
console.log(JSON.stringify(await evaluate(handler, brief)));
// an app may keep timers or handles open
process.exit(0);
