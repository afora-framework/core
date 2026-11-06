import { catalog } from "./catalog";
import { checkImport, isImportObject } from "./provider";
import { type Decl, issue, type Scope } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { SpecIssue, StageCatalogEntry } from "./spec/types";

type Path = readonly (string | number)[];

const OUTPUT_KEYS = ["commands", "statuses", "pipe"];

/** A stage of the catalog: built in, or supplied to codegen. */
export interface StageEntry {
	readonly name: string;
	readonly kind?: "transform" | "sink";
	/** Where an external one comes from; absent for the built-in ones. */
	readonly external?: StageCatalogEntry;
}

/** Every stage a pipe may name, by name: `StdStages` and the supplied ones. */
export function stageEntries(
	supplied: readonly StageCatalogEntry[],
): ReadonlyMap<string, StageEntry> {
	const entries = new Map<string, StageEntry>();
	for (const stage of catalog().stages) {
		entries.set(stage.name, { name: stage.name, kind: stage.kind });
	}
	for (const entry of supplied) {
		entries.set(entry.name, {
			name: entry.name,
			...(entry.kind ? { kind: entry.kind } : {}),
			external: entry,
		});
	}
	return entries;
}

/** The kind of a pipe entry as written. */
export function pipeKindOf(
	entry: unknown,
): "transform" | "sink" | "import" | undefined {
	if (!isObject(entry)) return undefined;
	if (Object.hasOwn(entry, "transform")) return "transform";
	if (Object.hasOwn(entry, "sink")) return "sink";
	if (Object.hasOwn(entry, "import")) return "import";
	return undefined;
}

function isJson(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	if (isObject(value)) return Object.values(value).every(isJson);
	return false;
}

/** Problems of the stage catalog given to codegen itself. */
export function checkStageCatalog(
	supplied: readonly StageCatalogEntry[],
	issues: SpecIssue[],
): void {
	const seen = new Set<string>(catalog().stages.map((stage) => stage.name));
	for (const [index, entry] of supplied.entries()) {
		const bad = (message: string) =>
			issues.push(
				issue([], "invalid_stage_catalog", `stages[${index}]: ${message}`),
			);
		if (!isObject(entry)) {
			bad("an entry is { name, module, export }.");
			continue;
		}
		if (typeof entry.name !== "string" || entry.name === "") {
			bad('"name" must be a non-empty string.');
		} else if (seen.has(entry.name)) {
			bad(
				`"${entry.name}" is ${catalog().stages.some((stage) => stage.name === entry.name) ? "built in" : "listed twice"}.`,
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
		if (
			entry.kind !== undefined &&
			entry.kind !== "transform" &&
			entry.kind !== "sink"
		) {
			bad('"kind" must be "transform" or "sink".');
		}
	}
}

/** Checks one `outputs` declaration. */
export function checkOutput(
	decl: Decl,
	scope: Scope,
	stages: ReadonlyMap<string, StageEntry>,
	issues: SpecIssue[],
): void {
	const path: Path = ["outputs", decl.name];
	const { spec } = decl;
	for (const key of Object.keys(spec)) {
		if (!OUTPUT_KEYS.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: ${OUTPUT_KEYS.join(", ")}.`,
				),
			);
		}
	}

	const { commands } = spec;
	if (!Array.isArray(commands) || commands.length === 0) {
		issues.push(
			issue(
				[...path, "commands"],
				"invalid_commands",
				'"commands" is required: a non-empty list of command names.',
			),
		);
	} else {
		for (const [index, name] of commands.entries()) {
			const here = [...path, "commands", index];
			const target =
				typeof name === "string" ? scope.decls.get(name) : undefined;
			if (target?.kind !== "command") {
				issues.push(
					issue(
						here,
						target ? "wrong_kind" : "unknown_command",
						target
							? `"${name}" is a ${target.kind}; an output takes commands.`
							: `${typeof name === "string" ? `"${name}"` : "The entry"} is not a declared command. Declare it in commands first.`,
					),
				);
			} else if (commands.indexOf(name) !== index) {
				issues.push(
					issue(here, "duplicate_command", `"${name}" is listed twice.`),
				);
			}
		}
	}

	const { statuses } = spec;
	if (statuses !== undefined) {
		if (!isObject(statuses)) {
			issues.push(
				issue(
					[...path, "statuses"],
					"invalid_statuses",
					'"statuses" is a map of exception name -> status, e.g. { "UserAlreadyExists": 409 }.',
				),
			);
		} else {
			for (const [name, status] of Object.entries(statuses)) {
				const here = [...path, "statuses", name];
				if (
					typeof status !== "number" ||
					!Number.isInteger(status) ||
					status < 400 ||
					status > 599
				) {
					issues.push(
						issue(
							here,
							"invalid_status",
							`The status of "${name}" must be an integer from 400 to 599.`,
						),
					);
				}
				if (
					scope.decls.get(name)?.kind !== "exception" &&
					!catalog().coreExceptions.includes(name)
				) {
					issues.push(
						issue(
							here,
							"unknown_exception",
							`"${name}" is not a declared exception nor one exported by @afora/core (afora_catalog coreExceptions).`,
						),
					);
				}
			}
		}
	}

	const { pipe } = spec;
	if (!Array.isArray(pipe)) {
		issues.push(
			issue(
				[...path, "pipe"],
				"invalid_pipe",
				'"pipe" is required: a list of { "transform" }, { "sink" } or { "import" } stages (it may be empty).',
			),
		);
		return;
	}
	for (const [index, entry] of pipe.entries()) {
		const here = [...path, "pipe", index];
		const kind = pipeKindOf(entry);
		if (kind === undefined || !isObject(entry)) {
			issues.push(
				issue(
					here,
					"invalid_stage",
					'A stage is { "transform": name, "options"? }, { "sink": name, "options"? } or { "import": "./stages.ts#name" }.',
				),
			);
			continue;
		}
		if (kind === "import") {
			if (isImportObject(entry)) checkImport(entry, here, issues);
			continue;
		}
		for (const key of Object.keys(entry)) {
			if (key !== kind && key !== "options") {
				issues.push(
					issue(
						[...here, key],
						"unknown_key",
						`"${key}" is not valid here. Valid keys: ${kind}, options.`,
					),
				);
			}
		}
		const name = entry[kind];
		const known = typeof name === "string" ? stages.get(name) : undefined;
		if (!known) {
			issues.push(
				issue(
					[...here, kind],
					"unknown_stage",
					`${typeof name === "string" ? `"${name}"` : `"${kind}"`} is not a stage of the catalog. Available: ${[...stages.keys()].join(", ")}. External stages are supplied to codegen as the \`stages\` option.`,
				),
			);
		} else if (known.kind !== undefined && known.kind !== kind) {
			issues.push(
				issue(
					[...here, kind],
					"stage_kind_mismatch",
					`"${known.name}" is a ${known.kind}: write { "${known.kind}": "${known.name}" }.`,
				),
			);
		}
		if (kind === "sink" && index !== pipe.length - 1) {
			issues.push(
				issue(
					here,
					"sink_not_last",
					"A sink builds the result, so it must be the last stage of the pipe.",
				),
			);
		}
		if (entry.options !== undefined) {
			if (!isObject(entry.options) || !isJson(entry.options)) {
				issues.push(
					issue(
						[...here, "options"],
						"invalid_stage_options",
						'"options" must be a JSON object (no functions or imports).',
					),
				);
			}
		}
	}
}
