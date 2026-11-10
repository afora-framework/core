import * as core from "@afora/core";
import { catalog } from "./catalog";
import { checkImport, isImportObject } from "./provider";
import { issue } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { EventPolicyCatalogEntry, SpecIssue } from "./spec/types";

/** An event policy of the catalog: built in, or supplied to codegen. */
export interface PolicyEntry {
	readonly name: string;
	/** Where an external one comes from; absent for the built-in ones. */
	readonly external?: EventPolicyCatalogEntry;
}

/** Every event policy a command may name, by name: `StdEventPolicies` and the supplied ones. */
export function policyEntries(
	supplied: readonly EventPolicyCatalogEntry[],
): ReadonlyMap<string, PolicyEntry> {
	const entries = new Map<string, PolicyEntry>();
	for (const policy of catalog().policies) {
		entries.set(policy.name, { name: policy.name });
	}
	for (const entry of supplied) {
		entries.set(entry.name, { name: entry.name, external: entry });
	}
	return entries;
}

/** Problems of the event policy catalog given to codegen itself. */
export function checkPolicyCatalog(
	supplied: readonly EventPolicyCatalogEntry[],
	issues: SpecIssue[],
): void {
	const builtin = new Set(catalog().policies.map((policy) => policy.name));
	const seen = new Set(builtin);
	for (const [index, entry] of supplied.entries()) {
		const bad = (message: string) =>
			issues.push(
				issue([], "invalid_policy_catalog", `policies[${index}]: ${message}`),
			);
		if (!isObject(entry)) {
			bad("an entry is { name, module, export }.");
			continue;
		}
		if (typeof entry.name !== "string" || !isIdentifier(entry.name)) {
			bad('"name" must be an identifier.');
		} else if (seen.has(entry.name)) {
			bad(
				`"${entry.name}" is ${builtin.has(entry.name) ? "built in" : "listed twice"}.`,
			);
		} else seen.add(entry.name);
		if (typeof entry.module !== "string" || entry.module === "") {
			bad(
				'"module" must be a package or a path relative to the output directory.',
			);
		}
		if (typeof entry.export !== "string" || !isIdentifier(entry.export)) {
			bad('"export" must be the name of the factory.');
		}
	}
}

/** Checks the top-level `publishers`: imports of publishers written by hand, by identifier key. */
export function checkPublishers(value: unknown, issues: SpecIssue[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		issues.push(
			issue(
				["publishers"],
				"invalid_publishers",
				'"publishers" is an object of publishers by key: { "realtime": { "import": "./realtime.ts#hub" } }.',
			),
		);
		return;
	}
	for (const [key, publisher] of Object.entries(value)) {
		const path = ["publishers", key];
		if (!isIdentifier(key)) {
			issues.push(
				issue(
					path,
					"invalid_name",
					`"${key}" is not a valid publisher key: use an identifier.`,
				),
			);
		}
		if (isImportObject(publisher)) checkImport(publisher, path, issues);
		else {
			issues.push(
				issue(
					path,
					"invalid_import",
					'A publisher is written by hand: { "import": "./realtime.ts#hub" }.',
				),
			);
		}
	}
}

function isJson(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	if (isObject(value)) return Object.values(value).every(isJson);
	return false;
}

/**
 * Checks `{ "policy": name, "options": {...} }` at `path`: a policy of the
 * catalog with JSON options. A built-in policy is made with its options, so
 * what `eventPolicyOf` would throw is an issue here; its `publisher` must be
 * a key of `publishers`. External ones are only checked as JSON.
 */
export function checkEventPolicy(
	value: Record<string, unknown>,
	path: readonly (string | number)[],
	policies: ReadonlyMap<string, PolicyEntry>,
	publisherKeys: ReadonlySet<string>,
	issues: SpecIssue[],
): void {
	for (const key of Object.keys(value)) {
		if (key !== "policy" && key !== "options") {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not a key of an event policy: { "policy": name, "options": {...} }.`,
				),
			);
		}
	}
	const { policy: name, options } = value;
	const entry =
		typeof name === "string" && policies.has(name)
			? (policies.get(name) as PolicyEntry)
			: undefined;
	if (!entry) {
		issues.push(
			issue(
				[...path, "policy"],
				"unknown_event_policy",
				`${typeof name === "string" ? `"${name}"` : "The policy"} is not an event policy of the catalog. Known: ${[...policies.keys()].join(", ")}; others are given to codegen (--policies).`,
			),
		);
		return;
	}
	if (options !== undefined && (!isObject(options) || !isJson(options))) {
		issues.push(
			issue(
				[...path, "options"],
				"invalid_event_policy_options",
				'"options" is a JSON object.',
			),
		);
		return;
	}
	if (entry.external) return;
	try {
		core.StdEventPolicies.resolve(
			entry.name,
			options as core.EventPolicyOptions | undefined,
		);
	} catch (error) {
		issues.push(
			issue(
				[...path, "options"],
				"invalid_event_policy_options",
				(error as { details?: { reason?: string } }).details?.reason ??
					String(error),
			),
		);
		return;
	}
	const publisher = (options as { publisher?: unknown } | undefined)?.publisher;
	if (typeof publisher === "string" && !publisherKeys.has(publisher)) {
		issues.push(
			issue(
				[...path, "options", "publisher"],
				"unknown_publisher",
				`"${publisher}" is not a key of "publishers". Declare it: "publishers": { "${publisher}": { "import": "./realtime.ts#hub" } }.`,
			),
		);
	}
}
