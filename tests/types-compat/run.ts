/**
 * Compiles `consumer.ts` against the packed package, as a consumer would
 * install it, with TypeScript 5.5, the latest 5.x and the TypeScript 7 of the
 * root, under `bundler` and `nodenext` resolution. Run with `bun run test:types`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "../..");

async function run(cwd: string, command: string[]): Promise<boolean> {
	const { exitCode } = await Bun.$`${command}`.cwd(cwd).nothrow();
	return exitCode === 0;
}

const packDir = await mkdtemp(join(tmpdir(), "afora-pack-"));
try {
	if (
		!(await run(root, [
			"bun",
			"pm",
			"pack",
			"--quiet",
			"--destination",
			packDir,
		]))
	)
		process.exit(1);
	if (!(await run(here, ["bun", "install"]))) process.exit(1);

	const installed = join(here, "node_modules/@afora/core");
	await rm(installed, { recursive: true, force: true });
	await Bun.$`mkdir -p ${installed}`;
	const [tarball] = [...new Bun.Glob("*.tgz").scanSync(packDir)];
	if (!tarball) throw new Error("bun pm pack produced no tarball");
	if (
		!(await run(here, [
			"tar",
			"xzf",
			join(packDir, tarball),
			"-C",
			installed,
			"--strip-components=1",
		]))
	)
		process.exit(1);
} finally {
	await rm(packDir, { recursive: true, force: true });
}

const compilers = [
	["TypeScript 5.5", join(here, "node_modules/ts55/bin/tsc")],
	["TypeScript 5 (latest)", join(here, "node_modules/ts5/bin/tsc")],
	["TypeScript 7", join(root, "node_modules/.bin/tsc")],
] as const;

let failed = false;
for (const [label, tsc] of compilers) {
	const version = (await Bun.$`${tsc} --version`.text()).trim();
	for (const resolution of ["bundler", "nodenext"]) {
		const ok = await run(here, [tsc, "-p", `tsconfig.${resolution}.json`]);
		console.log(
			`${ok ? "pass" : "FAIL"}  ${label} (${version}), ${resolution}`,
		);
		failed ||= !ok;
	}
}

process.exit(failed ? 1 : 0);
