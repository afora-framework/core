import {
	type COLLECTION_KEYS,
	catalog,
	declarationSchemas,
	fieldDefinition,
	generate,
	InvalidSpecError,
	type Spec,
	type SpecIssue,
	specSchema,
	writeGenerated,
} from "@afora/codegen";
import { type TSchema, Type } from "typebox";
import { extractFromApp, ToolError } from "./extract";
import {
	type Project,
	readSpec,
	validateInProject,
	writeSpec,
} from "./spec-file";
import { typecheck } from "./typecheck";

const json = <T>(schema: TSchema): T => JSON.parse(JSON.stringify(schema)) as T;

const KINDS = [
	"property",
	"blueprint",
	"record",
	"entity",
	"environment",
	"repository",
] as const;
type Kind = (typeof KINDS)[number];

const COLLECTION_OF: Readonly<Record<Kind, (typeof COLLECTION_KEYS)[number]>> =
	{
		property: "properties",
		blueprint: "blueprints",
		record: "records",
		entity: "entities",
		environment: "environments",
		repository: "repositories",
	};

type Json = Record<string, unknown>;

/** A tool: the name and description an agent sees, the JSON Schema of its input and its handler. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Json;
	readonly readOnly: boolean;
	handle(args: Json, project: Project): Promise<unknown>;
}

/** The schema of a whole spec as a property; its `$defs` go to the root of the tool's schema. */
const specInput = (): Json => {
	const { $defs: _defs, ...schema } = json<Json>(specSchema);
	return schema;
};
const FIELD_DEFS = { Field: json(fieldDefinition) };

function issuesResult(issues: SpecIssue[]) {
	return { valid: issues.length === 0, issues };
}

/** The spec to work on: the file, else the one extracted from the configured application, else an empty one. */
async function currentSpec(
	project: Project,
): Promise<{ spec: Spec; source: "file" | "app" | "new" }> {
	const spec = await readSpec(project);
	if (spec) return { spec, source: "file" };
	if (project.app) {
		return {
			spec: await extractFromApp(project.root, project.app),
			source: "app",
		};
	}
	return { spec: { version: 1 }, source: "new" };
}

function asSpec(value: unknown): Spec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ToolError(
			"`spec` must be a JSON object (the contents of afora.json).",
		);
	}
	return value as Spec;
}

function kindOf(value: unknown): Kind {
	if (!KINDS.includes(value as Kind)) {
		throw new ToolError(`\`kind\` must be one of: ${KINDS.join(", ")}.`);
	}
	return value as Kind;
}

function nameOf(value: unknown): string {
	if (typeof value !== "string" || value === "") {
		throw new ToolError(
			"`name` must be the PascalCase name of the declaration.",
		);
	}
	return value;
}

/** Saves `spec` if it validates; otherwise reports why and writes nothing. */
async function saveIfValid(project: Project, spec: Spec, extra: Json = {}) {
	const { issues } = await validateInProject(project, spec);
	if (issues.length > 0) {
		return {
			written: false,
			...issuesResult(issues),
			hint: "Nothing was written. Fix the issues (declare what a declaration uses first) and retry.",
			...extra,
		};
	}
	await writeSpec(project, spec);
	return { written: true, path: "afora.json", ...issuesResult([]), ...extra };
}

export const tools: readonly ToolDefinition[] = [
	{
		name: "afora_catalog",
		description:
			"What an afora.json can use, read from @afora/core: the Std properties (type, flags sensitive/unique/optional, and the `with` options each accepts), factories (enum), the Std record plugins (keys they add, unique/sensitive/change keys, methods), reserved record/entity keys, identity keys and the repository action rules. Call this first; do not guess property names.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		readOnly: true,
		handle: async () => catalog(),
	},
	{
		name: "afora_spec_read",
		description:
			"Reads the project's afora.json, with its validation issues. If there is none and the server was started with --app, returns the spec extracted from that application's code (not written). Use it before editing.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		readOnly: true,
		async handle(_args, project) {
			const spec = await readSpec(project);
			if (spec) {
				const { issues } = await validateInProject(project, spec);
				return {
					source: "file",
					path: "afora.json",
					spec,
					...issuesResult(issues),
				};
			}
			if (project.app) {
				const extracted = await extractFromApp(project.root, project.app);
				return {
					source: "app",
					app: project.app,
					spec: extracted,
					note: "Extracted from the code; nothing was written. afora_spec_write or afora_spec_upsert saves a spec as afora.json.",
				};
			}
			return {
				source: "none",
				spec: null,
				note: 'There is no afora.json yet. Start with afora_spec_upsert (it creates one) or afora_spec_write with { "version": 1, ... }.',
			};
		},
	},
	{
		name: "afora_extract",
		description:
			"Extracts the spec from an existing @afora/core Application in the project, by importing the module in a Bun subprocess (this runs the module's code). Does not write anything: review it, then save with afora_spec_write. Properties that cannot be expressed in JSON become opaque imports.",
		inputSchema: json(
			Type.Object(
				{
					app: Type.Optional(
						Type.String({
							description:
								'Path inside the project and export name, e.g. "src/app.ts#App". Defaults to the --app the server was started with.',
						}),
					),
					outputDir: Type.Optional(
						Type.String({
							description: "output.dir for the spec; src/domain by default.",
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
		readOnly: true,
		async handle(args, project) {
			const app = typeof args.app === "string" ? args.app : project.app;
			if (!app) {
				throw new ToolError(
					'Pass `app` ("src/app.ts#App") or start the server with --app.',
				);
			}
			const outputDir =
				typeof args.outputDir === "string" ? args.outputDir : undefined;
			const spec = await extractFromApp(project.root, app, outputDir);
			const { issues } = await validateInProject(project, spec);
			return { source: "app", app, spec, ...issuesResult(issues) };
		},
	},
	{
		name: "afora_spec_validate",
		description:
			"Validates a spec without writing anything and returns the issues ({ path, code, message }). Pass `spec` to check a draft, or omit it to check the afora.json on disk. Rules covered: unknown references, name collisions, cycles, reserved and identity keys, unique/sensitive/change naming missing keys, repository action rules (findBy only for unique keys, findManyBy only for non-unique), relations covering the entities held, invalid `with` options.",
		inputSchema: {
			type: "object",
			properties: {
				spec: {
					...specInput(),
					description: "A draft spec. Omit to validate afora.json on disk.",
				},
			},
			additionalProperties: false,
			$defs: FIELD_DEFS,
		},
		readOnly: true,
		async handle(args, project) {
			const spec = args.spec ?? (await readSpec(project));
			if (spec === undefined) {
				throw new ToolError("There is no afora.json to validate; pass `spec`.");
			}
			const { issues } = await validateInProject(project, spec);
			return issuesResult(issues);
		},
	},
	{
		name: "afora_spec_upsert",
		description:
			"Adds or replaces ONE declaration in afora.json (creating the file if needed), validates the whole spec and writes only if it is valid. Cheaper than resending the spec. `kind` is property | blueprint | record | entity | environment | repository; `declaration` is its JSON (see the schema). Declare what it references first (e.g. a blueprint before the entity that uses it, the entity before its repository). If invalid, nothing is written and the issues are returned.",
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: [...KINDS],
					description: "Which collection the declaration belongs to.",
				},
				name: {
					type: "string",
					pattern: "^[A-Z][A-Za-z0-9]*$",
					description: "PascalCase name, unique across all kinds.",
				},
				declaration: {
					description:
						"The declaration. property: { base, with? } | { enum } | { opaque, import }. blueprint/environment: { fields }. record/entity: { fields, unique?, sensitive?, change?, plugins? }. repository: { entity, actions, relations?, environments? }.",
					anyOf: Object.values(declarationSchemas).map((schema) =>
						json(schema),
					),
				},
			},
			required: ["kind", "name", "declaration"],
			additionalProperties: false,
			$defs: FIELD_DEFS,
		},
		readOnly: false,
		async handle(args, project) {
			const kind = kindOf(args.kind);
			const name = nameOf(args.name);
			const declaration = args.declaration;
			if (
				typeof declaration !== "object" ||
				declaration === null ||
				Array.isArray(declaration)
			) {
				throw new ToolError("`declaration` must be a JSON object.");
			}
			const { spec, source } = await currentSpec(project);
			const collection = COLLECTION_OF[kind];
			const existing = (spec as unknown as Json)[collection] as
				| Json
				| undefined;
			const next = {
				...spec,
				[collection]: { ...(existing ?? {}), [name]: declaration },
			} as unknown as Spec;
			return saveIfValid(project, next, {
				action: existing && name in existing ? "replaced" : "added",
				kind,
				name,
				...(source === "app"
					? {
							note: "There was no afora.json: started from the spec extracted from the application.",
						}
					: {}),
			});
		},
	},
	{
		name: "afora_spec_remove",
		description:
			"Removes ONE declaration from afora.json, validates the whole spec and writes only if it stays valid (so remove what depends on it first: a repository before its entity, an entity before the blueprint it uses is not needed, but anything referencing it must go or change).",
		inputSchema: json(
			Type.Object(
				{
					kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
					name: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		readOnly: false,
		async handle(args, project) {
			const kind = kindOf(args.kind);
			const name = nameOf(args.name);
			const { spec } = await currentSpec(project);
			const collection = COLLECTION_OF[kind];
			const existing = (spec as unknown as Json)[collection] as
				| Json
				| undefined;
			if (!existing || !(name in existing)) {
				throw new ToolError(
					`There is no ${kind} named "${name}" in afora.json.`,
				);
			}
			const { [name]: _removed, ...rest } = existing;
			const next = { ...spec } as unknown as Json;
			if (Object.keys(rest).length > 0) next[collection] = rest;
			else delete next[collection];
			return saveIfValid(project, next as unknown as Spec, {
				action: "removed",
				kind,
				name,
			});
		},
	},
	{
		name: "afora_spec_write",
		description:
			"Replaces the whole afora.json with `spec` (validated first; invalid specs are not written). Use it to create the spec in one go or to save one from afora_extract.",
		inputSchema: {
			type: "object",
			properties: { spec: specInput() },
			required: ["spec"],
			additionalProperties: false,
			$defs: FIELD_DEFS,
		},
		readOnly: false,
		async handle(args, project) {
			return saveIfValid(project, asSpec(args.spec), { action: "replaced" });
		},
	},
	{
		name: "afora_generate",
		description:
			"Generates the TypeScript from afora.json. With dryRun: true returns the files (path and contents) and writes nothing. Otherwise writes them under output.dir (overwriting or removing only files that carry the 'Generated by @afora/codegen' banner; anything else makes it refuse and write nothing), then runs `bunx tsc --noEmit -p <project>` if the project has a tsconfig.json and returns only the diagnostics of the generated files. Fix the spec, not the generated files.",
		inputSchema: json(
			Type.Object(
				{
					dryRun: Type.Optional(
						Type.Boolean({ description: "Return the files without writing." }),
					),
					typecheck: Type.Optional(
						Type.Boolean({
							description: "Run tsc after writing. Default true.",
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
		readOnly: false,
		async handle(args, project) {
			const spec = await readSpec(project);
			if (!spec) {
				throw new ToolError(
					"There is no afora.json to generate from. Create it with afora_spec_write or afora_spec_upsert.",
				);
			}
			const { extended, issues } = await validateInProject(project, spec);
			if (issues.length > 0)
				return { generated: false, ...issuesResult(issues) };
			let files: ReturnType<typeof generate>;
			try {
				files = generate(spec, extended);
			} catch (error) {
				if (error instanceof InvalidSpecError) {
					return { generated: false, ...issuesResult([...error.issues]) };
				}
				throw error;
			}
			if (args.dryRun === true) {
				const preview = await writeGenerated(project.root, files, {
					dryRun: true,
				});
				return {
					generated: true,
					dryRun: true,
					files,
					wouldRemove: preview.removed,
					refused: preview.refused,
				};
			}
			const result = await writeGenerated(project.root, files);
			if (result.refused.length > 0) {
				return {
					generated: false,
					refused: result.refused,
					hint: "Nothing was written. These files exist and are not generated ones (no banner), or are outside the project. Change output.dir or move them.",
				};
			}
			const check =
				args.typecheck === false
					? { ran: false as const, reason: "Skipped (typecheck: false)." }
					: await typecheck(
							project.root,
							files.map((file) => file.path),
						);
			return {
				generated: true,
				written: result.written,
				unchanged: result.unchanged,
				removed: result.removed,
				typecheck: check,
			};
		},
	},
];
