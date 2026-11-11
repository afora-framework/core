// `bun run.ts` times every contender on every scenario, on Bun and (if there
// is a `node`) on Node, measures bundle size and cold start, and writes
// results/latest.json and RESULTS.md.
//   --only flat,nested   only these scenarios; nothing is written
//   --guard              afora against Zod 4, fails over a limit (what CI runs)
//   --render             RESULTS.md again from results/latest.json, no timing
import { writeFileSync } from "node:fs";
import { guard } from "./guard.ts";
import {
	here,
	isBun,
	libraryVersions,
	loadScenarios,
	measure,
	type RuntimeReport,
} from "./harness.ts";
import { type Report, renderResults } from "./render.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const optionOf = (name: string) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const only = (process.env.BENCH_ONLY ?? optionOf("--only") ?? "")
	.split(",")
	.filter(Boolean);

const latest = `${here}results/latest.json`;

/** afora's source imports `typebox` and `slugify` from the root install. */
async function installRoot() {
	const root = `${here}..`;
	if (!(await Bun.file(`${root}/node_modules/typebox/package.json`).exists())) {
		await Bun.$`bun install`.cwd(root);
	}
}

/** The same benchmark on Node, against a build of afora; `undefined` when it cannot run. */
async function nodeLeg(): Promise<RuntimeReport | undefined> {
	const found = await Bun.$`node --version`.nothrow().quiet();
	if (found.exitCode !== 0) {
		console.log("No `node` found; the results are Bun-only.");
		return undefined;
	}
	const version = found.text().trim();
	const major = Number.parseInt(version.slice(1), 10);
	const build =
		await Bun.$`bun build ../src/index.ts --outfile .dist/afora.js --target node --format esm --packages external`
			.cwd(here)
			.nothrow()
			.quiet();
	if (major < 22 || build.exitCode !== 0) {
		console.log(`Node ${version} cannot run the benchmark; Bun-only.`);
		return undefined;
	}
	const flags =
		major >= 23 ? [] : ["--experimental-strip-types", "--no-warnings"];
	console.log(`\nRunning the same benchmark on Node ${version}...\n`);
	const child = await Bun.$`node ${flags} run.ts`
		.cwd(here)
		.env({ ...process.env, BENCH_CHILD: "1", BENCH_ONLY: only.join(",") })
		.nothrow();
	const file = Bun.file(`${here}.node-report.json`);
	if (child.exitCode !== 0 || !(await file.exists())) {
		console.log("The Node run failed; the results are Bun-only.");
		return undefined;
	}
	return (await file.json()) as RuntimeReport;
}

if (process.env.BENCH_CHILD === "1") {
	// Node leg: write the report for the parent to merge.
	const report = await measure(await loadScenarios(only));
	writeFileSync(`${here}.node-report.json`, JSON.stringify(report));
} else if (flag("--guard")) {
	await installRoot();
	process.exit(guard(await loadScenarios(only)) ? 0 : 1);
} else if (flag("--render")) {
	const report = (await Bun.file(latest).json()) as Report;
	await Bun.write(`${here}RESULTS.md`, renderResults(report));
	console.log(`Wrote ${here}RESULTS.md`);
} else {
	// Only Bun gets here: the Node leg is the `BENCH_CHILD` branch above.
	if (!isBun) throw new Error("Run it with Bun: `bun run bench`.");
	await installRoot();

	const runs: RuntimeReport[] = [await measure(await loadScenarios(only))];
	const node = await nodeLeg();
	if (node) runs.push(node);

	if (only.length > 0) {
		console.log(
			"\n--only: results/latest.json and RESULTS.md are left as they are.",
		);
	} else {
		const { footprints } = await import("./size.ts");
		const root = await Bun.file(`${here}../package.json`).json();
		const commit = await Bun.$`git rev-parse --short HEAD`
			.cwd(here)
			.nothrow()
			.text();
		const report: Report = {
			schema: 1,
			generatedAt: new Date().toISOString(),
			afora: { version: root.version, commit: commit.trim() || "unknown" },
			libraries: libraryVersions(),
			runs,
			footprints: await footprints(node ? ["bun", "node"] : ["bun"]),
		};
		await Bun.write(latest, `${JSON.stringify(report, null, "\t")}\n`);
		await Bun.write(`${here}RESULTS.md`, renderResults(report));
		console.log(`\nWrote ${latest} and ${here}RESULTS.md`);
	}
}
