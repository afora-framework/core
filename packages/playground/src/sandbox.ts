import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Sandbox = { id: string; name: string; code: string };
const suffix = ".sandbox.ts";

export function sandboxStore(project: string) {
	const root = join(project, ".afora", "sandbox");
	async function directory(parts: string[], create = false) {
		let path = project;
		for (const part of [".afora", "sandbox", ...parts]) {
			path = join(path, part);
			if (create)
				await mkdir(path).catch((error) => {
					if (error.code !== "EEXIST") throw error;
				});
			const stat = await lstat(path);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("Invalid sandbox directory");
		}
	}
	function validate(id: string) {
		if (
			typeof id !== "string" ||
			!id.endsWith(suffix) ||
			id.length > 240 ||
			id
				.split("/")
				.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						/[\\:]/.test(part) ||
						[...part].some((character) => character.charCodeAt(0) < 32),
				)
		)
			throw new Error("Invalid sandbox path");
		return id.split("/").slice(0, -1);
	}
	async function file(id: string, create = false) {
		await directory(validate(id), create);
		const path = join(root, id);
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error("Invalid sandbox file");
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
		return path;
	}
	return {
		async list(): Promise<Sandbox[]> {
			try {
				await directory([]);
			} catch (error) {
				if ((error as { code?: string }).code === "ENOENT") return [];
				throw error;
			}
			const result: Sandbox[] = [];
			async function walk(prefix = "") {
				for (const entry of await readdir(join(root, prefix), {
					withFileTypes: true,
				})) {
					const id = prefix + entry.name;
					if (entry.isDirectory()) await walk(`${id}/`);
					else if (entry.isFile() && id.endsWith(suffix))
						result.push({
							id,
							name: id.slice(0, -suffix.length),
							code: await Bun.file(await file(id)).text(),
						});
				}
			}
			await walk();
			return result.sort((a, b) => a.id.localeCompare(b.id));
		},
		async save(
			name: string,
			code: string,
			previous?: string,
		): Promise<Sandbox> {
			if (typeof name !== "string" || !name.trim() || typeof code !== "string")
				throw new Error("Invalid sandbox");
			const id = name.trim().endsWith(suffix)
				? name.trim()
				: `${name.trim()}${suffix}`;
			const old = previous === undefined ? undefined : await file(previous);
			const path = await file(id, true);
			await writeFile(path, code, { flag: previous === id ? "w" : "wx" });
			if (old && previous !== id) await unlink(old);
			return { id, name: id.slice(0, -suffix.length), code };
		},
		async remove(id: string) {
			await unlink(await file(id));
		},
	};
}
