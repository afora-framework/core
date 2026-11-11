import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANNER, generate, writeGenerated } from "../src";
import { blogSpec, quickstartSpec } from "./fixtures";

const dirs: string[] = [];
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "afora-write-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const exists = (path: string) => Bun.file(path).exists();

describe("writeGenerated", () => {
	test("writes the files, and finds them up to date the second time", async () => {
		const root = await temp();
		const files = generate(blogSpec);
		const first = await writeGenerated(root, files);
		expect([...first.written].sort()).toEqual(files.map((f) => f.path).sort());
		expect(await readFile(join(root, "src/domain/entities.ts"), "utf8")).toBe(
			files.find((f) => f.path.endsWith("entities.ts"))?.contents ?? "",
		);
		const second = await writeGenerated(root, files);
		expect(second.written).toEqual([]);
		expect(second.unchanged).toHaveLength(files.length);
	});

	test("dryRun touches nothing", async () => {
		const root = await temp();
		const result = await writeGenerated(root, generate(blogSpec), {
			dryRun: true,
		});
		expect(result.written.length).toBeGreaterThan(0);
		expect(await exists(join(root, "src/domain/index.ts"))).toBe(false);
	});

	test("never overwrites a file without the banner, and then writes nothing", async () => {
		const root = await temp();
		await mkdir(join(root, "src/domain"), { recursive: true });
		await writeFile(
			join(root, "src/domain/entities.ts"),
			"export const mine = 1;\n",
		);
		const result = await writeGenerated(root, generate(blogSpec));
		expect(result.refused.map((r) => r.path)).toEqual([
			"src/domain/entities.ts",
		]);
		expect(result.written).toEqual([]);
		expect(await readFile(join(root, "src/domain/entities.ts"), "utf8")).toBe(
			"export const mine = 1;\n",
		);
		expect(await exists(join(root, "src/domain/index.ts"))).toBe(false);
	});

	test("a hand-written file named as a generated one is refused, with the file and a rename", async () => {
		const root = await temp();
		const dir = join(root, "src/domain");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "greet.use-case.ts"), "export const mine = 1;\n");
		const files = [
			...generate(blogSpec),
			{ path: "src/domain/greet.use-case.ts", contents: `${BANNER}\n` },
		];
		const result = await writeGenerated(root, files);
		expect(result.refused).toHaveLength(1);
		const [refused] = result.refused;
		expect(refused?.path).toBe("src/domain/greet.use-case.ts");
		expect(refused?.reason).toContain("greet.use-case.ts");
		expect(refused?.reason).toContain("rename");
		expect(await readFile(join(dir, "greet.use-case.ts"), "utf8")).toBe(
			"export const mine = 1;\n",
		);
	});

	test("refuses paths outside the project", async () => {
		const root = await temp();
		const result = await writeGenerated(root, [
			{ path: "../escape.ts", contents: `${BANNER}\n` },
			{ path: "/tmp/absolute-escape.ts", contents: `${BANNER}\n` },
		]);
		expect(result.refused).toHaveLength(2);
		expect(await exists(join(root, "../escape.ts"))).toBe(false);
	});

	test("refuses a symlink that leaves the project", async () => {
		const root = await temp();
		const outside = await temp();
		await mkdir(join(root, "src"));
		await symlink(outside, join(root, "src/domain"));
		const result = await writeGenerated(root, generate(blogSpec));
		expect(result.refused.length).toBeGreaterThan(0);
		expect(await exists(join(outside, "index.ts"))).toBe(false);
	});

	test("refuses a symlinked file, even to a generated one", async () => {
		const root = await temp();
		const outside = await temp();
		await writeFile(join(outside, "target.ts"), `${BANNER}\n`);
		await mkdir(join(root, "src/domain"), { recursive: true });
		await symlink(
			join(outside, "target.ts"),
			join(root, "src/domain/index.ts"),
		);
		const result = await writeGenerated(root, generate(blogSpec));
		expect(result.refused.some((r) => r.path.endsWith("index.ts"))).toBe(true);
		expect(await readFile(join(outside, "target.ts"), "utf8")).toBe(
			`${BANNER}\n`,
		);
	});

	test("removes generated files the spec no longer produces, only if they carry the banner", async () => {
		const root = await temp();
		await writeGenerated(root, generate(blogSpec));
		expect(await exists(join(root, "src/domain/repositories.ts"))).toBe(true);
		// the quick start has neither entities nor repositories
		await writeFile(join(root, "src/domain/environments.ts"), "// mine now\n");
		const result = await writeGenerated(root, generate(quickstartSpec));
		expect(result.removed).toContain("src/domain/repositories.ts");
		expect(result.removed).toContain("src/domain/entities.ts");
		expect(result.removed).not.toContain("src/domain/environments.ts");
		expect(await exists(join(root, "src/domain/repositories.ts"))).toBe(false);
		expect(
			await readFile(join(root, "src/domain/environments.ts"), "utf8"),
		).toBe("// mine now\n");
	});

	test("removes the file of a use case that no longer needs one, only if it carries the banner", async () => {
		const root = await temp();
		const dir = join(root, "src/domain");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "greet.use-case.ts"), `${BANNER}\n`);
		await writeFile(join(dir, "mine.use-case.ts"), "// mine\n");
		const result = await writeGenerated(root, generate(blogSpec));
		expect(result.removed).toContain("src/domain/greet.use-case.ts");
		expect(result.removed).not.toContain("src/domain/mine.use-case.ts");
		expect(await exists(join(dir, "greet.use-case.ts"))).toBe(false);
		expect(await exists(join(dir, "mine.use-case.ts"))).toBe(true);
	});

	test("does not touch other files in the directory", async () => {
		const root = await temp();
		await mkdir(join(root, "src/domain"), { recursive: true });
		await writeFile(
			join(root, "src/domain/custom.ts"),
			`${BANNER}\nexport {};\n`,
		);
		await writeGenerated(root, generate(blogSpec));
		expect(await exists(join(root, "src/domain/custom.ts"))).toBe(true);
	});
});
