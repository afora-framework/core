import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const output = join(root, "dist/playground");
await mkdir(join(output, "assets"), { recursive: true });
const results = await Promise.all([
	Bun.build({
		entrypoints: [
			join(import.meta.dir, "server.ts"),
			join(import.meta.dir, "child.ts"),
		],
		outdir: output,
		target: "bun",
		packages: "bundle",
		external: [],
		minify: true,
	}),
	Bun.build({
		entrypoints: [
			join(import.meta.dir, "client.ts"),
			join(import.meta.dir, "editor.worker.ts"),
		],
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
	await copyFile(join(import.meta.dir, file), join(output, "assets", file));
const typescriptRoot = join(
	root,
	"node_modules/typescript-language-service/lib",
);
await mkdir(join(output, "typescript"), { recursive: true });
for await (const file of new Bun.Glob("lib*.d.ts").scan(typescriptRoot))
	await copyFile(join(typescriptRoot, file), join(output, "typescript", file));
await chmod(join(output, "server.js"), 0o755);
await mkdir(join(output, "licenses"), { recursive: true });
for (const [source, name] of [
	["monaco-editor/LICENSE", "monaco-LICENSE"],
	["typescript-language-service/LICENSE.txt", "typescript-LICENSE.txt"],
	[
		"typescript-language-service/ThirdPartyNoticeText.txt",
		"typescript-ThirdPartyNoticeText.txt",
	],
] as const) {
	await copyFile(
		join(root, "node_modules", source),
		join(output, "licenses", name),
	);
}
await copyFile(join(import.meta.dir, "README.md"), join(output, "README.md"));
console.log("Playground built in dist/playground");
