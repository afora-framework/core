/**
 * Evaluates one implementation in its own process and prints the evaluation
 * as JSON, so runs never share module state:
 *
 *   bun eval/check.ts afora <project dir>      # imports <dir>/src/domain, starts App, builds its Hono output
 *   bun eval/check.ts baseline <app.ts>        # imports the app (default export or `app`)
 */
import { join, resolve } from "node:path";
import { evaluate, type Handler } from "./invariants.ts";

interface Fetcher {
	fetch: Handler;
}
const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Fetcher).fetch === "function";

/** The Hono app of the first output of an afora application that builds one. */
async function aforaHandler(project: string): Promise<Handler> {
	const domain = await import(resolve(join(project, "src/domain/index.ts")));
	const App = domain.App;
	if (!App) throw new Error("src/domain exports no App.");
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

const [kind, target] = Bun.argv.slice(2);
if ((kind !== "afora" && kind !== "baseline") || !target) {
	throw new Error("Usage: bun eval/check.ts afora|baseline <path>");
}
const handler =
	kind === "afora" ? await aforaHandler(target) : await baselineHandler(target);
console.log(JSON.stringify(await evaluate(handler)));
// an app may keep timers or handles open
process.exit(0);
