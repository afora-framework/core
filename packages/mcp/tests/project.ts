import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerOptions } from "../src";

const ROOT = resolve(import.meta.dir, "../../..");
const SCRATCH = resolve(import.meta.dir, ".tmp");

/** A fresh project with a tsconfig that resolves `@afora/core` to its source. */
export async function makeProject(
	files: Readonly<Record<string, string>> = {},
): Promise<string> {
	await mkdir(SCRATCH, { recursive: true });
	const dir = await mkdtemp(join(SCRATCH, "project-"));
	const tsconfig = {
		compilerOptions: {
			target: "ESNext",
			module: "Preserve",
			moduleResolution: "bundler",
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			verbatimModuleSyntax: true,
			types: [],
			paths: { "@afora/core": [join(ROOT, "src/index.ts")] },
		},
		include: ["src"],
	};
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify(tsconfig, null, 2),
	);
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), contents);
	}
	return dir;
}

export const removeProject = (dir: string) =>
	rm(dir, { recursive: true, force: true });

// biome-ignore lint/suspicious/noExplicitAny: the shape of a tool result is checked by each test
type Loose = any;

export interface Connected {
	readonly client: Client;
	/** Calls a tool and gives its parsed JSON result (or the text of an error). */
	call(
		name: string,
		args?: Record<string, unknown>,
	): Promise<{ isError: boolean; data: Loose }>;
	close(): Promise<void>;
}

/** A client connected in memory to a server for `project`. */
export async function connect(options: ServerOptions): Promise<Connected> {
	const server = await createServer(options);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return {
		client,
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			const text =
				(result.content as { type: string; text: string }[])[0]?.text ?? "";
			let data: unknown = text;
			try {
				data = JSON.parse(text);
			} catch {}
			return { isError: result.isError === true, data };
		},
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
