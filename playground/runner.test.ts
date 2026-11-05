import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type ts from "typescript-language-service";
import { examples } from "./examples";
import { createProject, projectInfo } from "./project";
import { execute, type RunEvent } from "./runner";
import { snapshot } from "./serialize";

const root = resolve(import.meta.dir, "..");
const fixture = await mkdtemp(join(tmpdir(), "afora-consumer-"));
await mkdir(join(fixture, "node_modules/@afora"), { recursive: true });
await symlink(root, join(fixture, "node_modules/@afora/core"));
await Bun.write(
	join(fixture, "package.json"),
	JSON.stringify({
		name: "consumer-project",
		type: "module",
		dependencies: {
			"@afora/core": "0.0.2",
			"fixture-tool": "^1.0.0",
			"missing-library": "*",
		},
	}),
);
await Bun.write(
	join(fixture, "node_modules/fixture-tool/package.json"),
	JSON.stringify({
		name: "fixture-tool",
		version: "1.2.3",
		type: "module",
		exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
	}),
);
await Bun.write(
	join(fixture, "node_modules/fixture-tool/index.js"),
	'export const greet = (name) => "Hello " + name;',
);
await Bun.write(
	join(fixture, "node_modules/fixture-tool/index.d.ts"),
	"export declare function greet(name: string): string;",
);
await Bun.write(
	join(fixture, "local.ts"),
	'export const local = "from project";',
);
await Bun.write(
	join(fixture, "tsconfig.json"),
	JSON.stringify({
		compilerOptions: {
			strict: true,
			module: "ESNext",
			moduleResolution: "Bundler",
			target: "ESNext",
			paths: { "~/*": ["./*"] },
		},
	}),
);
afterAll(() => rm(fixture, { recursive: true, force: true }));

test("project manifest reports declared, installed and missing dependencies", async () => {
	const info = await projectInfo(fixture);
	expect(info.name).toBe("consumer-project");
	expect(
		info.dependencies.find((item) => item.name === "fixture-tool"),
	).toEqual({ name: "fixture-tool", requested: "^1.0.0", installed: "1.2.3" });
	expect(
		info.dependencies.find((item) => item.name === "missing-library")
			?.installed,
	).toBeNull();
});

test("IntelliSense resolves installed dependencies, local imports and tsconfig paths", () => {
	const project = createProject(fixture);
	const code =
		'import { greet } from "fixture-tool"; import { local } from "~/local"; greet(42); console.log(local);';
	const issues = project.query(code, "diagnostics") as { code: number }[];
	expect(issues.map((issue) => issue.code)).toEqual([2345]);
	const info = project.query(
		code,
		"hover",
		code.indexOf("greet(42)"),
	) as ts.QuickInfo;
	expect(info.displayParts?.map((part) => part.text).join("")).toContain(
		"name: string",
	);
	project.dispose();
});

test("afora completion preserves generated methods in source and installed modes", () => {
	for (const [directory, source] of [
		[root, true],
		[fixture, false],
	] as const) {
		const project = createProject(directory, source);
		const code = `${examples[0]?.code}\nuser.`;
		const completions = project.query(
			code,
			"complete",
			code.length,
		) as ts.CompletionEntry[];
		expect(completions.map((entry) => entry.name)).toContain("change");
		project.dispose();
	}
});

test("all shipped examples type-check against source", () => {
	const project = createProject(root, true);
	for (const example of examples)
		expect(project.query(example.code, "diagnostics"), example.name).toEqual(
			[],
		);
	project.dispose();
}, 30000);

test("runs consumer imports from installed packages and relative project files", async () => {
	const events: RunEvent[] = [];
	await execute(
		'import { greet } from "fixture-tool"; import { local } from "./local.ts"; console.log(greet(local));',
		fixture,
		false,
		(event) => events.push(event),
	);
	expect(events.find((event) => event.type === "log")?.values).toEqual([
		"Hello from project",
	]);
	expect(events.at(-1)?.exitCode).toBe(0);
});

test("runs tsconfig aliases", async () => {
	const events: RunEvent[] = [];
	await execute(
		'import { local } from "~/local"; console.log(local);',
		fixture,
		false,
		(event) => events.push(event),
	);
	expect(events.find((event) => event.type === "log")?.values).toEqual([
		"from project",
	]);
	expect(events.at(-1)?.exitCode).toBe(0);
});

test("examples execute with structured logs and layered errors", async () => {
	for (const example of examples) {
		const events: RunEvent[] = [];
		await execute(example.code, root, true, (event) => events.push(event));
		expect(
			events.at(-1)?.exitCode,
			`${example.name}: ${JSON.stringify(events)}`,
		).toBe(example.name === "Exceções em camadas" ? 1 : 0);
		expect(events.some((event) => event.type === "log")).toBe(true);
	}
});

test("terminates infinite loops and cancels running processes", async () => {
	const events: RunEvent[] = [];
	await execute(
		"while (true) {}",
		root,
		true,
		(event) => events.push(event),
		undefined,
		150,
	);
	expect(events.at(-1)?.reason).toBe("timeout");
	const controller = new AbortController();
	const running = execute(
		"while (true) {}",
		root,
		true,
		(event) => events.push(event),
		controller.signal,
	);
	setTimeout(() => controller.abort(), 100);
	await running;
	expect(events.at(-1)?.reason).toBe("cancelled");
});

test("serialization honors toJSON and handles cycles without invoking getters", () => {
	const value: Record<string, unknown> = {
		secret: { toJSON: () => "********" },
	};
	value.self = value;
	Object.defineProperty(value, "getter", {
		enumerable: true,
		get: () => {
			throw new Error("must not run");
		},
	});
	expect(snapshot(value)).toEqual({
		secret: "********",
		self: "[Circular]",
		getter: "[Getter]",
	});
});

test("sandbox files survive reopening, support subfolders and never clobber another file", async () => {
	const { sandboxStore } = await import("./sandbox");
	const store = sandboxStore(fixture);
	expect(await store.list()).toEqual([]);
	const first = await store.save("nested/Customer", "console.log(1)");
	expect(first.id).toBe("nested/Customer.sandbox.ts");
	expect(await Bun.file(join(fixture, ".afora/sandbox", first.id)).text()).toBe(
		first.code,
	);
	expect(await sandboxStore(fixture).list()).toEqual([first]);
	await expect(store.save("nested/Customer", "overwrite")).rejects.toThrow();
	const updated = await store.save(first.name, "console.log(2)", first.id);
	const other = await store.save("Other", "other");
	await expect(store.save("Other", "overwrite", first.id)).rejects.toThrow();
	expect(await store.list()).toContainEqual(other);
	const renamed = await store.save("renamed", updated.code, first.id);
	expect(
		await Bun.file(join(fixture, ".afora/sandbox", first.id)).exists(),
	).toBe(false);
	await store.remove(renamed.id);
	await store.remove(other.id);
	expect(await store.list()).toEqual([]);
});

test("sandbox paths cannot escape the directory or follow symlinks", async () => {
	const { sandboxStore } = await import("./sandbox");
	const store = sandboxStore(fixture);
	for (const name of [
		"../escape",
		"/tmp/escape",
		"nested/../../escape",
		"nested\\escape",
	])
		await expect(store.save(name, "bad")).rejects.toThrow();
	await symlink(
		join(fixture, "local.ts"),
		join(fixture, ".afora/sandbox/link.sandbox.ts"),
	);
	await expect(store.save("link", "bad", "link.sandbox.ts")).rejects.toThrow();
	await expect(store.remove("link.sandbox.ts")).rejects.toThrow();
	await symlink(fixture, join(fixture, ".afora/sandbox/outside"));
	await expect(store.save("outside/escape", "bad")).rejects.toThrow();
	expect(await store.list()).toEqual([]);
	expect(await Bun.file(join(fixture, "local.ts")).text()).toBe(
		'export const local = "from project";',
	);
});
