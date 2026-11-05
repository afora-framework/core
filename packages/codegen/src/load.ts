import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ResolvedSpec, Spec } from "./spec/types";

/** Thrown when a spec file cannot be read, parsed, or one it extends cannot be found. */
export class SpecLoadError extends Error {
	override readonly name = "SpecLoadError";
}

/** A spec read from disk, with the specs it extends (recursively), by the reference it uses. */
export interface LoadedSpec {
	readonly spec: Spec;
	readonly path: string;
	readonly extended: Readonly<Record<string, ResolvedSpec>>;
}

async function read(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new SpecLoadError(
			`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new SpecLoadError(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The file a reference points to: a relative path (a directory means its afora.json) or a package. */
export function referenceToPath(ref: string, from: string): string {
	if (ref.startsWith(".") || isAbsolute(ref)) {
		const path = resolve(dirname(from), ref);
		return path.endsWith(".json") ? path : resolve(path, "afora.json");
	}
	try {
		return createRequire(from).resolve(`${ref}/afora.json`);
	} catch {
		throw new SpecLoadError(
			`Cannot find the package "${ref}" (or its afora.json) from ${dirname(from)}. It must export "./afora.json".`,
		);
	}
}

function referencesOf(spec: unknown): string[] {
	return typeof spec === "object" &&
		spec !== null &&
		Array.isArray((spec as Spec).extends)
		? ((spec as Spec).extends as unknown[]).filter(
				(ref): ref is string => typeof ref === "string",
			)
		: [];
}

class Loader {
	private readonly cache = new Map<string, ResolvedSpec>();
	private readonly loading = new Set<string>();

	async extended(
		spec: unknown,
		file: string,
	): Promise<Record<string, ResolvedSpec>> {
		const extended: Record<string, ResolvedSpec> = {};
		for (const ref of referencesOf(spec)) {
			extended[ref] = await this.load(referenceToPath(ref, file));
		}
		return extended;
	}

	async load(file: string): Promise<ResolvedSpec> {
		const cached = this.cache.get(file);
		if (cached) return cached;
		if (this.loading.has(file)) {
			throw new SpecLoadError(`${file} extends itself (a cycle of "extends").`);
		}
		this.loading.add(file);
		const spec = (await read(file)) as Spec;
		const extended = await this.extended(spec, file);
		this.loading.delete(file);
		const resolved: ResolvedSpec = { spec, extends: extended };
		this.cache.set(file, resolved);
		return resolved;
	}
}

/**
 * Reads an `afora.json` and the specs it extends, recursively. A spec reached
 * twice is the same object, so `validateSpec` and `generate` dedupe it.
 */
export async function loadSpec(path: string): Promise<LoadedSpec> {
	const absolute = resolve(path);
	const root = await new Loader().load(absolute);
	return { spec: root.spec, path: absolute, extended: root.extends ?? {} };
}

/**
 * The specs that `spec` extends, loaded as `loadSpec` would if `spec` were
 * the file `file` (its references resolve from there).
 */
export function resolveExtended(
	spec: unknown,
	file: string,
): Promise<Record<string, ResolvedSpec>> {
	return new Loader().extended(spec, resolve(file));
}
