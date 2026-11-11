// What a library adds to a bundle, and how long a new process takes to load
// it: each file of entries/ is bundled by itself (minified, for Node), its
// size is taken, and the bundle is imported in new processes of Bun and Node.
import { gzipSync } from "node:zlib";
import { LIBRARIES } from "./contenders.ts";

const here = new URL(".", import.meta.url).pathname;
const out = `${here}.dist/entries`;
/** A new process per run; the median of this many counts. */
const COLD_RUNS = 15;

export type Footprint = {
	library: string;
	/** Bytes of the minified bundle, and of it gzipped. */
	min: number;
	gzip: number;
	/** Milliseconds to import the bundle in a new process: load, build the schema, validate once. */
	cold: Record<string, number>;
};

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

async function coldOf(command: string, file: string): Promise<number> {
	const script = `const s=performance.now();await import(${JSON.stringify(file)});console.log(performance.now()-s)`;
	const times: number[] = [];
	for (let run = 0; run < COLD_RUNS; run++) {
		const text = await Bun.$`${command} --input-type=module -e ${script}`
			.nothrow()
			.text();
		const time = Number.parseFloat(text);
		if (!Number.isNaN(time)) times.push(time);
	}
	if (times.length === 0)
		throw new Error(`${command} could not import ${file}`);
	return median(times);
}

export async function footprints(runtimes: string[]): Promise<Footprint[]> {
	const rows: Footprint[] = [];
	for (const library of Object.keys(LIBRARIES)) {
		const built = await Bun.build({
			entrypoints: [`${here}entries/${library}.ts`],
			outdir: out,
			target: "node",
			format: "esm",
			minify: true,
			naming: `${library}.mjs`,
		});
		if (!built.success) {
			throw new Error(`${library}: ${built.logs.join("\n")}`);
		}
		const file = `${out}/${library}.mjs`;
		const bytes = await Bun.file(file).bytes();
		const cold: Record<string, number> = {};
		for (const runtime of runtimes) cold[runtime] = await coldOf(runtime, file);
		rows.push({
			library,
			min: bytes.length,
			gzip: gzipSync(bytes).length,
			cold,
		});
	}
	return rows;
}

if (import.meta.main) {
	console.table(await footprints(["bun", "node"]));
}
