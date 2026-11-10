import { catalog } from "./catalog";
import { isDeclarationName, isObject } from "./spec/field";
import {
	COLLECTIONS,
	type DeclKind,
	KIND_OF,
	type ResolvedSpec,
	type SpecIssue,
} from "./spec/types";

/** A declaration of the spec, or of one it extends. */
export interface Decl {
	readonly kind: DeclKind;
	readonly name: string;
	/** The declaration as written (compared by identity to tell two apart). */
	readonly spec: Record<string, unknown>;
	/** The label of the spec that declares it. */
	readonly origin: string;
	/** For an inherited declaration: the reference of the extended spec it comes through. */
	readonly via?: string;
}

/** A key of the top-level `providers`, of the spec or of one it extends. */
interface ProviderKey {
	readonly key: string;
	/** The provider as written (compared by identity). */
	readonly spec: unknown;
	/** The label of the spec that declares it. */
	readonly origin: string;
	/** For an inherited key: the reference of the extended spec it comes through. */
	readonly via?: string;
	/** Declared by a spec the extended one extends: not importable from here. */
	readonly nested?: boolean;
}

export interface Scope {
	readonly decls: ReadonlyMap<string, Decl>;
	/** The keys of `providers`, its own and inherited ones. */
	readonly providerKeys: ReadonlyMap<string, ProviderKey>;
	/** The extended specs, by reference, in order. */
	readonly extended: ReadonlyMap<string, ResolvedSpec>;
}

export function issue(
	path: readonly (string | number)[],
	code: string,
	message: string,
): SpecIssue {
	return { path, code, message };
}

function labelOf(resolved: ResolvedSpec, ref: string): string {
	return typeof resolved.spec?.name === "string" ? resolved.spec.name : ref;
}

/** Every declaration `resolved` declares or inherits, in order. */
function declarationsOf(
	resolved: ResolvedSpec,
	ref: string,
	seen: Set<ResolvedSpec>,
): Decl[] {
	if (seen.has(resolved)) return [];
	seen.add(resolved);
	const found: Decl[] = [];
	for (const [childRef, child] of Object.entries(resolved.extends ?? {})) {
		found.push(...declarationsOf(child, childRef, seen));
	}
	const spec = resolved.spec as unknown as Record<string, unknown>;
	for (const collection of COLLECTIONS) {
		const declared = spec?.[collection];
		if (!isObject(declared)) continue;
		for (const [name, value] of Object.entries(declared)) {
			if (!isObject(value)) continue;
			found.push({
				kind: KIND_OF[collection],
				name,
				spec: value,
				origin: labelOf(resolved, ref),
			});
		}
	}
	return found;
}

/** Every key of `providers` that `resolved` declares or inherits, in order. */
function providerKeysOf(
	resolved: ResolvedSpec,
	ref: string,
	seen: Set<ResolvedSpec>,
): ProviderKey[] {
	if (seen.has(resolved)) return [];
	seen.add(resolved);
	const found: ProviderKey[] = [];
	for (const [childRef, child] of Object.entries(resolved.extends ?? {})) {
		for (const key of providerKeysOf(child, childRef, seen)) {
			found.push({ ...key, nested: true });
		}
	}
	const providers = (resolved.spec as unknown as Record<string, unknown>)
		?.providers;
	if (isObject(providers)) {
		for (const [key, value] of Object.entries(providers)) {
			found.push({ key, spec: value, origin: labelOf(resolved, ref) });
		}
	}
	return found;
}

/** The keys of `providers` a `provider` of the spec can name: its own and those of the specs it extends directly. */
export const usableProviderKeys = (scope: Scope): string[] =>
	[...scope.providerKeys.values()]
		.filter((found) => found.nested !== true)
		.map((found) => found.key);

/**
 * The declarations in scope: those of `spec` and of the specs it extends.
 * Reports what `applicationOf` would throw for: a name taken twice, or by
 * different declarations of different specs.
 */
export function scopeOf(
	spec: Record<string, unknown>,
	extended: Readonly<Record<string, ResolvedSpec>>,
	issues: SpecIssue[],
): Scope {
	const decls = new Map<string, Decl>();
	const byObject = new Map<object, Decl>();
	const extendedRefs = new Map<string, ResolvedSpec>();
	const reserved = new Set(catalog().reservedDeclarationNames);

	const refs = Array.isArray(spec.extends) ? spec.extends : [];
	const seen = new Set<ResolvedSpec>();
	for (const [index, ref] of refs.entries()) {
		if (typeof ref !== "string") continue;
		const resolved = Object.hasOwn(extended, ref) ? extended[ref] : undefined;
		if (!resolved) {
			issues.push(
				issue(
					["extends", index],
					"unresolved_extends",
					`The spec "${ref}" that this one extends was not loaded. Give a relative path to its afora.json or a package that ships one.`,
				),
			);
			continue;
		}
		extendedRefs.set(ref, resolved);
		for (const decl of declarationsOf(resolved, ref, seen)) {
			const same = decls.get(decl.name);
			if (same) {
				if (same.spec === decl.spec) continue;
				issues.push(
					issue(
						["extends", index],
						"extends_conflict",
						`${decl.kind} "${decl.name}" of "${decl.origin}" is a different declaration from the ${same.kind} "${same.name}" of "${same.origin}". Rename one of them.`,
					),
				);
				continue;
			}
			const other = byObject.get(decl.spec);
			if (other) {
				issues.push(
					issue(
						["extends", index],
						"extends_conflict",
						`The same ${decl.kind} is "${other.name}" in "${other.origin}" and "${decl.name}" in "${decl.origin}".`,
					),
				);
				continue;
			}
			const inherited: Decl = { ...decl, via: ref };
			decls.set(decl.name, inherited);
			byObject.set(decl.spec, inherited);
		}
	}

	for (const collection of COLLECTIONS) {
		const declared = spec[collection];
		if (declared === undefined) continue;
		if (!isObject(declared)) {
			issues.push(
				issue(
					[collection],
					"invalid_collection",
					`"${collection}" must be an object of declarations by name.`,
				),
			);
			continue;
		}
		for (const [name, value] of Object.entries(declared)) {
			const path = [collection, name];
			if (!isDeclarationName(name)) {
				issues.push(
					issue(
						path,
						"invalid_name",
						`"${name}" is not a valid declaration name: use PascalCase (letters and digits, starting with a capital), as Std properties are lowercase.`,
					),
				);
				continue;
			}
			if (reserved.has(name)) {
				issues.push(
					issue(
						path,
						"reserved_name",
						`"${name}" is exported by @afora/core (or is "App" or "Providers") and the generated code imports or exports it. Pick another name.`,
					),
				);
				continue;
			}
			if (!isObject(value)) {
				issues.push(
					issue(path, "invalid_declaration", `"${name}" must be an object.`),
				);
				continue;
			}
			const same = decls.get(name);
			if (same) {
				issues.push(
					issue(
						path,
						"name_collision",
						same.via === undefined
							? `"${name}" is already declared as a ${same.kind}; names are shared by every kind of declaration.`
							: `"${name}" is already declared by "${same.origin}" (extended); rename it.`,
					),
				);
				continue;
			}
			const decl: Decl = {
				kind: KIND_OF[collection],
				name,
				spec: value,
				origin: typeof spec.name === "string" ? spec.name : "this spec",
			};
			decls.set(name, decl);
			byObject.set(value, decl);
		}
	}
	const providerKeys = new Map<string, ProviderKey>();
	const keySeen = new Set<ResolvedSpec>();
	const addKey = (found: ProviderKey, path: readonly (string | number)[]) => {
		const same = providerKeys.get(found.key);
		if (same === undefined) {
			providerKeys.set(found.key, found);
			return;
		}
		if (same.spec === found.spec) return;
		issues.push(
			issue(
				path,
				"provider_conflict",
				`The provider "${found.key}" of "${found.origin}" is a different provider from the "${found.key}" of "${same.origin}". Rename one of them.`,
			),
		);
	};
	for (const [index, ref] of refs.entries()) {
		const resolved = extendedRefs.get(ref);
		if (resolved === undefined) continue;
		for (const found of providerKeysOf(resolved, ref, keySeen)) {
			addKey({ ...found, via: ref }, ["extends", index]);
		}
	}
	if (isObject(spec.providers)) {
		for (const [key, value] of Object.entries(spec.providers)) {
			addKey(
				{
					key,
					spec: value,
					origin: typeof spec.name === "string" ? spec.name : "this spec",
				},
				["providers", key],
			);
		}
	}
	return { decls, providerKeys, extended: extendedRefs };
}

/**
 * Checks `value` as the `environments` of a declaration at `path`: a list of
 * distinct names of declared environments. Gives the names, when a list.
 */
export function checkEnvironmentNames(
	value: unknown,
	path: readonly (string | number)[],
	scope: Scope,
	issues: SpecIssue[],
): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		issues.push(issue(path, "invalid_option", "Must be an array of strings."));
		return [];
	}
	for (const [index, name] of value.entries()) {
		const here = [...path, index];
		const other = scope.decls.get(name);
		if (other?.kind !== "environment") {
			issues.push(
				issue(
					here,
					"unknown_environment",
					`"${name}" is not a declared environment.`,
				),
			);
		} else if (value.indexOf(name) !== index) {
			issues.push(
				issue(here, "duplicate_environment", `"${name}" is listed twice.`),
			);
		}
	}
	return value;
}
