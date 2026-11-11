// `bun run.ts --compare <base>` times afora as it is in this checkout against
// afora as it is in another one (`<base>` is the root of that checkout, or a
// built module), in one process and taking turns, and fails when a guarded
// row got slower than the limit. It is how a pull request is held to its base.
import { resolve } from "node:path";
import { type Contender, GUARDED, WATCHED } from "./contenders.ts";
import { fmtNs, timeCases } from "./guard.ts";
import { here, KINDS, loadAfora, loadScenarios } from "./harness.ts";

/** The most a guarded row may take, as a multiple of the same row on the base. */
export const COMPARE_LIMIT = 1.1;
/** Held to the limit. The others are shown, since they move with it. */
const HELD = [GUARDED];
const SHOWN = [GUARDED, WATCHED, "afora Entity.safeParse"];

/** Builds afora from the checkout at `root` into .dist/, the way the Node leg does. */
async function build(root: string, name: string): Promise<string> {
	const out = `${here}.dist/${name}.js`;
	const built =
		await Bun.$`bun build ${root}/src/index.ts --outfile ${out} --target node --format esm --packages external`
			.nothrow()
			.quiet();
	if (built.exitCode !== 0) {
		throw new Error(`Could not build ${root}: ${built.stderr.toString()}`);
	}
	return out;
}

export async function compare(base: string, only: string[]): Promise<boolean> {
	// Relative to where the command runs, not to this file.
	const baseFile = base.endsWith(".js")
		? resolve(base)
		: await build(resolve(base), "afora-base");
	// The head is built the same way, so that both sides are the same kind of module.
	const headFile = await build(`${here}..`, "afora-head");
	const [baseScenarios, headScenarios] = await Promise.all([
		loadScenarios(only, await loadAfora(baseFile)),
		loadScenarios(only, await loadAfora(headFile)),
	]);

	const pick = (contenders: Contender[], name: string, side: string) => {
		const found = contenders.find((contender) => contender.name === name);
		if (!found) throw new Error(`No "${name}" on the ${side}`);
		return { ...found, name: `${side}: ${name}` };
	};
	const timed = timeCases(
		headScenarios.flatMap((scenario, index) =>
			KINDS.map((kind) => ({
				scenario,
				kind,
				contenders: SHOWN.flatMap((name) => [
					pick(baseScenarios[index]?.contenders ?? [], name, "base"),
					pick(scenario.contenders, name, "head"),
				]),
			})),
		),
	);

	let passed = true;
	const lines = [
		"### afora against its base",
		"",
		`Best of 9 rounds of each side after a warm-up, taking turns in one process. A \`${GUARDED.replace("afora ", "")}\` row over ${COMPARE_LIMIT}x its base fails the check.`,
		"",
		"| Case | Row | Base | Head | Head / base | |",
		"| --- | --- | ---: | ---: | ---: | --- |",
	];
	for (const { scenario, kind, runs } of timed) {
		for (const name of SHOWN) {
			const baseRun = runs.find((run) => run.name === `base: ${name}`);
			const headRun = runs.find((run) => run.name === `head: ${name}`);
			if (!baseRun || !headRun) continue;
			const ratio = headRun.best / baseRun.best;
			const held = HELD.includes(name);
			let mark = "";
			if (held && ratio > COMPARE_LIMIT) {
				passed = false;
				mark = "slower: fails";
			} else if (ratio > COMPARE_LIMIT) mark = "slower";
			else if (ratio < 1 / COMPARE_LIMIT) mark = "faster";
			lines.push(
				`| ${scenario} ${kind} | ${name.replace("afora ", "")} | ${fmtNs(baseRun.best)} ns | ${fmtNs(headRun.best)} ns | ${ratio.toFixed(2)}x | ${mark} |`,
			);
		}
	}
	lines.push(
		"",
		passed
			? "No guarded row is slower than the limit."
			: "A guarded row is slower than the limit. Run it again to rule out noise (`bun run bench -- --compare <checkout of the base>`), then find what the change costs.",
	);
	const text = lines.join("\n");
	console.log(text);
	if (process.env.BENCH_COMPARE_OUT) {
		await Bun.write(process.env.BENCH_COMPARE_OUT, `${text}\n`);
	}
	return passed;
}
