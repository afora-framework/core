import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "src");
const output = join(root, "dist");
const packageDir = (name: string) =>
	dirname(Bun.resolveSync(`${name}/package.json`, root));
await mkdir(join(output, "assets"), { recursive: true });
const results = await Promise.all([
	Bun.build({
		entrypoints: [join(source, "server.ts"), join(source, "child.ts")],
		outdir: output,
		target: "bun",
		packages: "bundle",
		external: [],
		minify: true,
	}),
	Bun.build({
		entrypoints: [join(source, "client.ts"), join(source, "editor.worker.ts")],
		outdir: join(output, "assets"),
		target: "browser",
		naming: "[name].[ext]",
		minify: true,
		loader: { ".ttf": "file" },
	}),
]);
for (const result of results)
	if (!result.success)
		throw new AggregateError(result.logs, "Playground build failed");
for (const file of ["index.html", "style.css"])
	await copyFile(join(source, file), join(output, "assets", file));
const typescriptRoot = join(packageDir("typescript-language-service"), "lib");
await mkdir(join(output, "typescript"), { recursive: true });
for await (const file of new Bun.Glob("lib*.d.ts").scan(typescriptRoot))
	await copyFile(join(typescriptRoot, file), join(output, "typescript", file));
await chmod(join(output, "server.js"), 0o755);
await mkdir(join(output, "licenses"), { recursive: true });
for (const [pkg, file, name] of [
	["monaco-editor", "LICENSE", "monaco-LICENSE"],
	["typescript-language-service", "LICENSE.txt", "typescript-LICENSE.txt"],
	[
		"typescript-language-service",
		"ThirdPartyNoticeText.txt",
		"typescript-ThirdPartyNoticeText.txt",
	],
] as const) {
	await copyFile(join(packageDir(pkg), file), join(output, "licenses", name));
}
console.log("Playground built in packages/playground/dist");
