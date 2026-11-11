// What a library adds to a bundle, and how long a new process takes to load
// it: each file of entries/ is bundled by itself (minified, for Node), its
// size is taken, and the bundle is imported in new processes of Bun and Node,
// each running a file that does nothing else.
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
	/**
	 * Milliseconds to import the bundle in a new process: load, build the
	 * schema, validate once. By the version of the runtime, as its run states
	 * it ("Bun 1.4.4", "Node v24.11.0"); by `bun` and `node` in schema 1.
	 */
	cold: Record<string, number>;
};

/** A runtime to start: its binary, and the name its cold start is kept under. */
export type ColdRuntime = { label: string; command: string };

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

/**
 * The script each process runs: it imports the bundle it is given and prints
 * how long that took. It is a file, not `-e`: Bun runs what it gets from `-e`
 * 1.5x to 4x slower than the same code from a file, which made every library
 * that works at import look slower on Bun than it is.
 */
const IMPORTER = `${out}/import.mjs`;
const IMPORTER_SOURCE =
	"const s=performance.now();await import(process.argv[2]);console.log(performance.now()-s);\n";

async function coldOf(command: string, file: string): Promise<number> {
	const times: number[] = [];
	for (let run = 0; run < COLD_RUNS; run++) {
		const text = await Bun.$`${command} ${IMPORTER} ${file}`.nothrow().text();
		const time = Number.parseFloat(text);
		if (!Number.isNaN(time)) times.push(time);
	}
	if (times.length === 0)
		throw new Error(`${command} could not import ${file}`);
	return median(times);
}

/**
 * afora's entry imports `typebox` to declare its schemas, and afora itself
 * imports it from the root install: two copies on disk (`bench/package.json`
 * pins its own), both of which went into its bundle. An application has one,
 * so every entry resolves `typebox` to the copy afora uses, TypeBox's own
 * included: the two are measured on the same version.
 */
const oneTypeBox: Bun.BunPlugin = {
	name: "one-typebox",
	setup(build) {
		build.onResolve({ filter: /^typebox(\/|$)/ }, ({ path }) => ({
			path: Bun.resolveSync(path, `${here}..`),
		}));
	},
};

export async function footprints(
	runtimes: ColdRuntime[],
): Promise<Footprint[]> {
	const rows: Footprint[] = [];
	for (const library of Object.keys(LIBRARIES)) {
		const built = await Bun.build({
			entrypoints: [`${here}entries/${library}.ts`],
			outdir: out,
			target: "node",
			format: "esm",
			minify: true,
			naming: `${library}.mjs`,
			plugins: [oneTypeBox],
		});
		if (!built.success) {
			throw new Error(`${library}: ${built.logs.join("\n")}`);
		}
		await Bun.write(IMPORTER, IMPORTER_SOURCE);
		const file = `${out}/${library}.mjs`;
		const bytes = await Bun.file(file).bytes();
		const cold: Record<string, number> = {};
		for (const { label, command } of runtimes) {
			cold[label] = await coldOf(command, file);
		}
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
	console.table(
		await footprints([
			{ label: "bun", command: "bun" },
			{ label: "node", command: "node" },
		]),
	);
}
