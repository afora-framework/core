// `bun run.ts` times every contender on every scenario, on Bun and (if there
// is a `node`) on Node, measures bundle size and cold start, and writes
// results/latest.json and RESULTS.md.
//   --only flat,nested   only these scenarios; nothing is written
//   --rounds 3           times each row is timed, in turns; the best counts (default 3)
//   --jobs 3             that many rows at a time, to iterate: the times are off by 1.4x and more, and nothing is written
//   --guard              afora against Zod 4, fails over a limit (what CI runs)
//   --render             RESULTS.md again from results/latest.json, no timing
import { writeFileSync } from "node:fs";
import type { Scenario } from "./contenders.ts";
import { fmtNs, guard } from "./guard.ts";
import {
	here,
	isBun,
	KINDS,
	type Kind,
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

/** Processes at a time. Above 1 they share the machine and its cores, and a row takes 1.4x to 4x its time alone: for iterating, never for publishing. */
const jobs = Math.max(1, Number.parseInt(optionOf("--jobs") ?? "1", 10) || 1);

/** Times each row is timed, in turns; the best counts. */
const rounds = Math.max(
	1,
	Number.parseInt(optionOf("--rounds") ?? "3", 10) || 3,
);

const latest = `${here}results/latest.json`;

/** afora's source imports `typebox` and `slugify` from the root install. */
async function installRoot() {
	const root = `${here}..`;
	if (!(await Bun.file(`${root}/node_modules/typebox/package.json`).exists())) {
		await Bun.$`bun install`.cwd(root);
	}
}

type Runtime = { name: "bun" | "node"; command: string[] };

/** Bun, and Node when there is one that can run the benchmark against a build of afora. */
async function runtimes(): Promise<Runtime[]> {
	const list: Runtime[] = [{ name: "bun", command: ["bun"] }];
	const found = await Bun.$`node --version`.nothrow().quiet();
	if (found.exitCode !== 0) {
		console.log("No `node` found; the results are Bun-only.");
		return list;
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
		return list;
	}
	const flags =
		major >= 23 ? [] : ["--experimental-strip-types", "--no-warnings"];
	list.push({ name: "node", command: ["node", ...flags] });
	return list;
}

/**
 * Every row of a runtime, each timed by a process of its own: one contender,
 * one case, nothing before it. `jobs` of them run at a time. `undefined` when
 * a process fails.
 */
async function leg(
	runtime: Runtime,
	scenarios: Scenario[],
	jobs: number,
): Promise<RuntimeReport | undefined> {
	const rows = scenarios.flatMap((scenario) =>
		KINDS.flatMap((kind) =>
			scenario.contenders.map((contender, index) => ({
				scenario,
				kind,
				contender,
				index,
			})),
		),
	);
	const parts: Array<RuntimeReport | undefined> = new Array(rows.length);
	let next = 0;
	let failed = false;
	const worker = async (slot: number) => {
		const out = `${here}.dist/row-${runtime.name}-${slot}.json`;
		while (!failed && next < rows.length) {
			const position = next++;
			const { scenario, kind, contender, index } = rows[
				position
			] as (typeof rows)[number];
			const child = await Bun.$`${runtime.command} run.ts`
				.cwd(here)
				.env({
					...process.env,
					BENCH_CHILD: "1",
					BENCH_ONLY: scenario.id,
					BENCH_PICK: `${kind},${index}`,
					BENCH_OUT: out,
				})
				.nothrow()
				.quiet();
			if (child.exitCode !== 0) {
				failed = true;
				console.log(child.stderr.toString());
				console.log(`The ${runtime.name} run failed at ${scenario.id}.`);
				return;
			}
			const part = (await Bun.file(out).json()) as RuntimeReport;
			const row = part.tables[0]?.rows[0];
			const best = parts[position]?.tables[0]?.rows[0];
			if (!best || (row && row.avg < best.avg)) parts[position] = part;
			console.log(
				`${runtime.name.padEnd(4)}  ${`${scenario.id} ${kind}`.padEnd(22)} ${fmtNs(row?.avg ?? 0).padStart(9)} ns  ${contender.name}`,
			);
		}
	};
	// Every row is timed once per round and its best round counts. A machine
	// drifts over the minutes a run takes (heat, power, other programs); taking
	// turns spreads that over every row instead of the rows of one moment.
	for (let round = 1; round <= rounds && !failed; round++) {
		console.log(`\n${runtime.name}: round ${round} of ${rounds}`);
		next = 0;
		await Promise.all(Array.from({ length: jobs }, (_, slot) => worker(slot)));
	}
	if (failed) return undefined;

	// Merged in the order of the scenarios, whatever order the processes ended in.
	let report: RuntimeReport | undefined;
	for (const part of parts) {
		const table = part?.tables[0];
		const row = table?.rows[0];
		if (!part || !table || !row) continue;
		report ??= { ...part, tables: [] };
		const merged = report.tables.find(
			(candidate) =>
				candidate.scenario === table.scenario && candidate.case === table.case,
		);
		if (merged) merged.rows.push(row);
		else report.tables.push({ ...table, rows: [row] });
	}
	return report;
}

if (process.env.BENCH_CHILD === "1") {
	// One row, for the parent to merge.
	const [kind, index] = (process.env.BENCH_PICK ?? "").split(",");
	const report = await measure(await loadScenarios(only), {
		kind: kind as Kind,
		contender: Number(index),
	});
	writeFileSync(process.env.BENCH_OUT as string, JSON.stringify(report));
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

	const scenarios = await loadScenarios(only);
	const runs: RuntimeReport[] = [];
	for (const runtime of await runtimes()) {
		const report = await leg(runtime, scenarios, jobs);
		if (report) runs.push(report);
	}
	if (runs.length === 0) throw new Error("Nothing was measured.");
	const node = runs.some((run) => run.runtime === "node");

	if (only.length > 0 || jobs > 1) {
		const file = `${here}.dist/partial.json`;
		await Bun.write(file, JSON.stringify(runs));
		console.log(
			`\n--only or --jobs: results/latest.json and RESULTS.md are left as they are; the rows are in ${file}.`,
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
