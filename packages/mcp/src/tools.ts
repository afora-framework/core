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
import { describeApp, extractFromApp, ToolError } from "./extract";
import {
	projectDifferences,
	projectViewOfDescription,
	projectViewOfSpec,
} from "./project-view";
import {
	codegenOptionsOf,
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
	"exception",
	"useCase",
	"command",
	"output",
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
		exception: "exceptions",
		useCase: "useCases",
		command: "commands",
		output: "outputs",
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
			"What an afora.json can use, read from @afora/core: the Std properties (type, flags sensitive/unique/optional, and the `with` options each accepts), factories (enum), the Std record plugins (keys they add, unique/sensitive/change keys, methods), reserved record/entity keys, identity keys and the repository action rules. The `providers` list is what `provider.use` may name; `exceptionLayers` and `coreExceptions` are what an exception's `layer` and a use case's `errors` may use; `stages` (select, openapi and the ones given to the server with --stages) are what an output's `pipe` may name with `transform` or `sink`; `policies` (publishEvents and the ones given with --policies) are what a command's `events` may name with `policy`. Call this first; do not guess property names.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		readOnly: true,
		handle: async (_args, project) => ({
			...catalog(),
			providers: [
				{
					name: "inMemory",
					builtin: true,
					note: 'provider: "inMemory" (or { "use": "inMemory" }), no options.',
				},
				...(project.providers ?? []),
			],
			stages: [
				...catalog().stages,
				...(project.stages ?? []).map((stage) => ({
					...stage,
					builtin: false,
				})),
			],
			policies: [
				...catalog().policies,
				...(project.policies ?? []).map((policy) => ({
					...policy,
					builtin: false,
				})),
			],
		}),
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
		name: "afora_project",
		description:
			"The project as a map, without writing anything: its entities and repositories, every operation (command, use case, how it is implemented: steps, code or a standard use case, its declared route and access), and each output with the route every operation is served at (method, path, status, and whether the sink, the use case or the default decided it) and who may call it (public, open, authenticated, scopes, owner). `notes` point at what deserves a look: operations left open beside protected ones, operations that will answer 401 for lack of an authenticator, commands no output serves. Read from the running application when the server was started with --app or `app` is given (this imports the module in a Bun subprocess, and works on code written by hand, with no afora.json); from afora.json otherwise. `source` chooses: `file` reads afora.json even when there is an application, `app` the application. When the project has both, the result has `drift`: where the application and afora.json say different things (declarations in only one of them, an operation implemented, routed or protected differently, another path in an output), so a spec that fell behind the code, or code that was not regenerated, is seen at once; `compare: false` skips it (and does not import the application when reading the file). Call it before adding a use case or a route, to see what exists and which paths are taken.",
		inputSchema: json(
			Type.Object(
				{
					app: Type.Optional(
						Type.String({
							description:
								'An application to read, as a path inside the project and an export name: "src/app.ts#App". Defaults to the --app the server was started with, else afora.json.',
						}),
					),
					compare: Type.Optional(
						Type.Boolean({
							description:
								"Compare the application with afora.json when the project has both, and report the differences in `drift`. Default true.",
						}),
					),
					source: Type.Optional(
						Type.Union([Type.Literal("app"), Type.Literal("file")], {
							description:
								'Where to read the project from: "file" is afora.json, "app" the application. By default the application when one is known, else afora.json.',
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
		readOnly: true,
		async handle(args, project) {
			const { source } = args;
			if (source !== undefined && source !== "app" && source !== "file") {
				throw new ToolError('`source` must be "app" or "file".');
			}
			if (source === "file" && typeof args.app === "string") {
				throw new ToolError(
					'`app` names an application, and `source` is "file": give one of them.',
				);
			}
			const app = typeof args.app === "string" ? args.app : project.app;
			if (source === "app" && !app) {
				throw new ToolError(
					'No application is known. Pass `app` ("src/app.ts#App") or start the server with --app.',
				);
			}
			const spec = await readSpec(project);
			const fromFile = spec ? projectViewOfSpec(spec) : undefined;
			const inherits = (spec?.extends?.length ?? 0) > 0;
			/** The differences between the two, when the project has both and they can be read. */
			const driftOf = async (
				application?: ReturnType<typeof projectViewOfDescription>,
			) => {
				if (args.compare === false || !app || !fromFile) return {};
				try {
					const fromApp =
						application ??
						projectViewOfDescription(await describeApp(project.root, app));
					const differences = projectDifferences(fromApp, fromFile, inherits);
					return {
						drift: {
							between: [app, "afora.json"],
							inSync: differences.length === 0,
							differences,
						},
					};
				} catch (error) {
					return {
						drift: {
							between: [app, "afora.json"],
							error: `The application could not be read: ${error instanceof Error ? error.message : String(error)}`,
						},
					};
				}
			};
			if (app && source !== "file") {
				const view = projectViewOfDescription(
					await describeApp(project.root, app),
				);
				return { source: "app", app, ...view, ...(await driftOf(view)) };
			}
			if (!spec) {
				throw new ToolError(
					source === "file"
						? "There is no afora.json in the project."
						: 'There is no afora.json and no application was given. Pass `app` ("src/app.ts#App"), start the server with --app, or create a spec with afora_spec_upsert.',
				);
			}
			return {
				source: "file",
				...(fromFile as NonNullable<typeof fromFile>),
				...(await driftOf()),
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
					imports: Type.Optional(
						Type.Record(Type.String(), Type.String(), {
							description:
								'Where what cannot be described is imported from: a property name -> module, and "./file.ts#export" (relative to output.dir) for a provider not created with providerOf ("provider", "repositories.<Name>.provider" or "providers.<key>" for one of the top-level providers), a use case with a hand-written execute ("useCases.<Name>") and a run function of a steps use case ("useCases.<Name>.run.<name>"), a command handler ("commands.<Name>.events", "commands.<Name>.onEventError"), a publisher ("publishers.<key>") and a stage written by hand ("outputs.<Name>.pipe.<index>"). Without it extraction fails with an error naming the key.',
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
			const imports =
				typeof args.imports === "object" &&
				args.imports !== null &&
				!Array.isArray(args.imports)
					? (args.imports as Record<string, string>)
					: undefined;
			const spec = await extractFromApp(project.root, app, outputDir, imports);
			const { issues } = await validateInProject(project, spec);
			return { source: "app", app, spec, ...issuesResult(issues) };
		},
	},
	{
		name: "afora_spec_validate",
		description:
			"Validates a spec without writing anything and returns the issues ({ path, code, message }). Pass `spec` to check a draft, or omit it to check the afora.json on disk. Rules covered (use cases: references, dependency kinds, errors registered or core, every step rule with the codes unknown_step, invalid_reference, unbound_reference, unknown_key, unknown_dependency, unknown_action, write_in_find, undeclared_error, missing_return, misplaced_return, invalid_step_name, invalid_class, invalid_change_key, invalid_value, invalid_import; commands: unknown_use_case, invalid_use_cases, invalid_operation, invalid_events, event_error_requires_after_commit, unknown_event_policy, invalid_event_policy_options, unknown_publisher; publishers: invalid_publishers, invalid_import; outputs: unknown_command, invalid_commands, invalid_pipe, invalid_stage, unknown_stage, stage_kind_mismatch, sink_not_last, invalid_stage_options, invalid_statuses, invalid_status, unknown_exception): unknown references, name collisions, cycles, reserved and identity keys, unique/sensitive/change naming missing keys, repository action rules (findBy only for unique keys, findManyBy only for non-unique; findMany, exists, findPage need no key), providers (unknown_provider, invalid_provider, invalid_import), relations covering the entities held, invalid `with` options.",
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
			"Adds or replaces ONE declaration in afora.json (creating the file if needed), validates the whole spec and writes only if it is valid. Cheaper than resending the spec. `kind` is property | blueprint | record | entity | environment | repository | exception | useCase | command | output; `declaration` is its JSON (see the schema). Declare what it references first (e.g. a blueprint before the entity that uses it, the entity before its repository). If invalid, nothing is written and the issues are returned.",
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
						'The declaration. property: { base, with? } | { enum } | { opaque, import }. blueprint/environment: { fields }. record/entity: { fields, unique?, sensitive?, change?, plugins? }; an entity also takes events?: { onCreate?, onUpdate?, onDelete? }, each "name" | { name, handler?: { import } } or a list of them. repository: { entity, actions, provider?, deletion?: hard | soft, relations?, environments? }. exception: { layer, message? }. useCase: { description?, tags?, deprecated?, input, response, context?, dependencies?, errors?, implementation: { steps: [...] } | { import: "../handlers/x.ts#Name" } } (see the guide for steps). command: { description?, tags?, context?, useCases: { op: "UseCaseName" }, transaction?, events?: "after-commit" | "manual" | { policy, options? } | { import }, onEventError?: { import } }. output: { commands: [names], statuses?: { ExceptionName: 400-599 }, pipe: [{ transform, options? } | { sink, options? } | { import }] }. provider: "inMemory" | { use, options? } | { import: "./file.ts#name" } | "<key>" of the top-level `providers` (the application provider and the named `providers` are top-level keys of the spec: afora_spec_write). A use case dependency can also be "Logger"; the top-level `log` is { level?, providers: ["json" | "console" | { import }] }; the top-level `publishers` is { key: { import } }, where event policies such as publishEvents publish.',
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
				files = generate(spec, extended, codegenOptionsOf(project));
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
