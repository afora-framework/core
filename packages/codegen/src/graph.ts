import { type StdPropertyInfo, stdProperty } from "./catalog";
import { type Field, parseFields } from "./model";
import type { Decl, Scope } from "./scope";
import type { EnumValue, SpecIssue } from "./spec/types";

/** The fields of a declaration that has them, parsed (malformed ones are left out). */
export function fieldsOfDecl(decl: Decl): Record<string, Field> | undefined {
	if (
		decl.kind !== "blueprint" &&
		decl.kind !== "record" &&
		decl.kind !== "entity" &&
		decl.kind !== "environment"
	) {
		return undefined;
	}
	const sink: SpecIssue[] = [];
	return parseFields(decl.spec.fields, [], sink) ?? undefined;
}

/** The names of the declarations (PascalCase types) `fields` use, at any depth of inline fields. */
function typesIn(fields: Readonly<Record<string, Field>>): string[] {
	const found: string[] = [];
	const visit = (field: Field): void => {
		if (field.kind === "type") {
			if (/^[A-Z]/.test(field.type)) found.push(field.type);
		} else if (field.kind === "inline") {
			for (const inner of Object.values(field.fields)) visit(inner);
		}
	};
	for (const field of Object.values(fields)) visit(field);
	return found;
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** The declarations (by name, in scope) that `decl` needs to be declared first. */
function dependenciesOf(decl: Decl, scope: Scope): string[] {
	let names: string[] = [];
	switch (decl.kind) {
		case "property":
			if (typeof decl.spec.base === "string") names = [decl.spec.base];
			break;
		case "repository":
			names = [
				...(typeof decl.spec.entity === "string" ? [decl.spec.entity] : []),
				...stringsOf(decl.spec.relations),
				...stringsOf(decl.spec.environments),
			];
			break;
		default: {
			const fields = fieldsOfDecl(decl);
			names = fields ? typesIn(fields) : [];
		}
	}
	return [...new Set(names)].filter((name) => scope.decls.has(name));
}

/**
 * The own declarations in an order where each comes after what it needs
 * (ties by name, so the order is deterministic), and the cycles found.
 */
export function orderOf(
	own: readonly Decl[],
	scope: Scope,
): { order: Decl[]; cycles: string[][] } {
	const ownNames = new Set(own.map((decl) => decl.name));
	const needs = new Map(
		own.map((decl) => [
			decl.name,
			dependenciesOf(decl, scope).filter((name) => ownNames.has(name)),
		]),
	);
	const cycles: string[][] = [];

	const state = new Map<string, "open" | "done">();
	const stack: string[] = [];
	const visit = (name: string): void => {
		state.set(name, "open");
		stack.push(name);
		for (const next of needs.get(name) ?? []) {
			if (state.get(next) === "open") {
				cycles.push([...stack.slice(stack.indexOf(next)), next]);
			} else if (!state.has(next)) visit(next);
		}
		stack.pop();
		state.set(name, "done");
	};
	for (const name of [...ownNames].sort()) {
		if (!state.has(name)) visit(name);
	}

	const remaining = new Map(
		[...needs].map(([name, list]) => [name, new Set(list)]),
	);
	const order: Decl[] = [];
	const byName = new Map(own.map((decl) => [decl.name, decl]));
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter(([, list]) => list.size === 0)
			.map(([name]) => name)
			.sort();
		const next = ready[0];
		if (next === undefined) break;
		order.push(byName.get(next) as Decl);
		remaining.delete(next);
		for (const list of remaining.values()) list.delete(next);
	}
	return { order, cycles };
}

/** What a property is, once its chain of declarations is followed to the end. */
export type Root =
	| { readonly kind: "std"; readonly info: StdPropertyInfo }
	| { readonly kind: "enum"; readonly values: readonly EnumValue[] }
	| { readonly kind: "opaque" };

/** The root of a property type: a Std property, an enum or an opaque import; `undefined` if it is none. */
export function rootOf(
	type: string,
	scope: Scope,
	seen: ReadonlySet<string> = new Set(),
): Root | undefined {
	if (/^[a-z]/.test(type)) {
		const info = stdProperty(type);
		return info?.usable ? { kind: "std", info } : undefined;
	}
	const decl = scope.decls.get(type);
	if (decl?.kind !== "property" || seen.has(type)) return undefined;
	const { spec } = decl;
	if (spec.opaque === true) return { kind: "opaque" };
	if (Array.isArray(spec.enum)) {
		return { kind: "enum", values: spec.enum as EnumValue[] };
	}
	if (typeof spec.base === "string") {
		return rootOf(spec.base, scope, new Set([...seen, type]));
	}
	return undefined;
}

/** Whether `field` is an object (not a list) property with a flag of its root. */
export function flagOf(
	field: Field,
	flag: "unique" | "sensitive",
	scope: Scope,
): boolean {
	if (field.kind !== "type") return false;
	if (flag === "unique" && field.list) return false;
	const root = rootOf(field.type, scope);
	return root?.kind === "std" && root.info[flag];
}
