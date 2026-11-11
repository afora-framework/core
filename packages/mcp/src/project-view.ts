import type { Spec } from "@afora/codegen";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** What a use case says of itself, whatever it was read from. */
interface UseCaseFacts {
	readonly description?: string;
	/** `steps`, `code` (a hand-written execute) or `standard:<name>`. */
	readonly implementation: string;
	readonly route?: Json;
	readonly access?: Json;
	readonly input?: readonly string[];
}

/** The declarations of a project the view is made of. */
interface ProjectFacts {
	readonly name?: string;
	readonly entities: Readonly<Record<string, Json>>;
	readonly repositories: Readonly<Record<string, Json>>;
	readonly useCases: Readonly<Record<string, UseCaseFacts>>;
	/** Command name -> operation name -> use case name. */
	readonly commands: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly outputs: Readonly<
		Record<
			string,
			{
				readonly commands: readonly string[];
				readonly stages: readonly {
					readonly kind: string;
					readonly name?: string;
					readonly options?: Json;
				}[];
			}
		>
	>;
}

/** One operation as an output serves it. */
export interface RouteView {
	readonly operation: string;
	readonly useCase: string;
	readonly method: string;
	readonly path: string;
	readonly status: number;
	/** Where the method and path come from. */
	readonly routedBy: "sink" | "use case" | "default";
	/** `public`, `open` (nothing declared), `authenticated` or `scopes: a, b`, plus `owner`. */
	readonly access: string;
}

/** What `afora_project` gives: the project as a map. */
export interface ProjectView {
	readonly name?: string;
	readonly entities: readonly {
		readonly name: string;
		readonly fields: readonly string[];
		readonly plugins: readonly string[];
	}[];
	readonly repositories: readonly {
		readonly name: string;
		readonly entity?: string;
		readonly actions: readonly string[];
	}[];
	readonly operations: readonly {
		readonly id: string;
		readonly command: string;
		readonly useCase: string;
		readonly implementation: string;
		readonly description?: string;
		readonly input?: readonly string[];
		readonly route?: Json;
		readonly access?: Json;
	}[];
	readonly outputs: readonly {
		readonly name: string;
		readonly sink?: string;
		readonly basePath?: string;
		readonly docs?: string;
		/** `auth.jwt` when the sink options hold it; hooks are code, which this view cannot see. */
		readonly authentication: string;
		readonly routes: readonly RouteView[];
	}[];
	/** What deserves a look: operations that are open, or closed for lack of an authenticator. */
	readonly notes: readonly string[];
}

/** `changePassword` -> `change-password`, as the sinks do. */
function kebab(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function accessText(access: Json | undefined): string {
	if (!access) return "open";
	if (access.public === true) return "public";
	const scopes = Array.isArray(access.scopes) ? access.scopes : [];
	const parts = [
		scopes.length > 0 ? `scopes: ${scopes.join(", ")}` : "authenticated",
	];
	if (isObject(access.owner))
		parts.push(`owner: ${String(access.owner.input)}`);
	return parts.join("; ");
}

const HTTP_SINKS = ["hono", "fastify", "express", "elysia", "openapi"];

function viewOf(facts: ProjectFacts): ProjectView {
	const notes: string[] = [];
	const operations: ProjectView["operations"][number][] = [];
	for (const [command, entries] of Object.entries(facts.commands)) {
		for (const [name, useCase] of Object.entries(entries)) {
			const known = facts.useCases[useCase];
			operations.push({
				id: `${command}.${name}`,
				command,
				useCase,
				implementation: known?.implementation ?? "unknown",
				...(known?.description ? { description: known.description } : {}),
				...(known?.input ? { input: known.input } : {}),
				...(known?.route ? { route: known.route } : {}),
				...(known?.access ? { access: known.access } : {}),
			});
		}
	}
	const outputs = Object.entries(facts.outputs).map(([name, output]) => {
		const sink = output.stages.find((stage) => stage.kind === "sink");
		const options = sink?.options ?? {};
		const http = sink?.name !== undefined && HTTP_SINKS.includes(sink.name);
		const basePath =
			typeof options.basePath === "string" ? options.basePath : "";
		const overrides = isObject(options.route) ? options.route : {};
		const hasAuth = isObject(options.auth);
		const routes: RouteView[] = [];
		for (const operation of operations) {
			if (!output.commands.includes(operation.command)) continue;
			const chosen = isObject(overrides[operation.id])
				? (overrides[operation.id] as Json)
				: {};
			const declared = operation.route ?? {};
			const [, operationName] = operation.id.split(".") as [string, string];
			routes.push({
				operation: operation.id,
				useCase: operation.useCase,
				method: String(chosen.method ?? declared.method ?? "post"),
				path:
					basePath +
					String(
						chosen.path ??
							declared.path ??
							`/${kebab(operation.command)}/${kebab(operationName)}`,
					),
				status: Number(chosen.status ?? declared.status ?? 200),
				routedBy:
					chosen.method !== undefined || chosen.path !== undefined
						? "sink"
						: operation.route
							? "use case"
							: "default",
				access: accessText(operation.access),
			});
		}
		if (http || sink?.name === "mcpTools" || sink?.name === "websocket") {
			const guarded = routes.filter(
				(route) => route.access !== "open" && route.access !== "public",
			);
			if (guarded.length > 0 && !hasAuth && sink?.name !== "openapi") {
				notes.push(
					`Output "${name}": ${guarded.length} operation(s) declare an access and its sink options have no "auth". Unless the stage is given an authenticator in code (its hooks), they answer 401.`,
				);
			}
			const open = routes.filter((route) => route.access === "open");
			if (open.length > 0 && guarded.length > 0) {
				notes.push(
					`Output "${name}": ${open.map((route) => route.operation).join(", ")} declare no access beside operations that do; say { "public": true } where anyone may call.`,
				);
			}
		}
		return {
			name,
			...(sink?.name ? { sink: sink.name } : {}),
			...(basePath ? { basePath } : {}),
			...(isObject(options.docs) && typeof options.docs.path === "string"
				? { docs: options.docs.path }
				: {}),
			authentication: hasAuth
				? "auth.jwt"
				: "not in the sink options (an authenticator hook is code)",
			routes: http ? routes : routes.map((route) => ({ ...route })),
		};
	});
	const served = new Set(
		Object.values(facts.outputs).flatMap((output) => output.commands),
	);
	const unserved = Object.keys(facts.commands).filter(
		(command) => !served.has(command),
	);
	if (unserved.length > 0) {
		notes.push(
			`No output serves the command(s) ${unserved.join(", ")}: their operations run only in process.`,
		);
	}
	return {
		...(facts.name ? { name: facts.name } : {}),
		entities: Object.entries(facts.entities).map(([name, entity]) => ({
			name,
			fields: Object.keys(isObject(entity.fields) ? entity.fields : {}),
			plugins: (Array.isArray(entity.plugins) ? entity.plugins : []).map(
				(plugin) =>
					typeof plugin === "string"
						? plugin
						: String((plugin as Json).name ?? "plugin"),
			),
		})),
		repositories: Object.entries(facts.repositories).map(
			([name, repository]) => ({
				name,
				...(typeof repository.entity === "string"
					? { entity: repository.entity }
					: {}),
				actions: Array.isArray(repository.actions)
					? (repository.actions as string[])
					: [],
			}),
		),
		operations,
		outputs,
		notes,
	};
}

/** The view of the project an `afora.json` describes. */
export function projectViewOfSpec(spec: Spec): ProjectView {
	const source = spec as unknown as Json;
	const collection = (key: string): Json =>
		isObject(source[key]) ? (source[key] as Json) : {};
	const useCases: Record<string, UseCaseFacts> = {};
	for (const [name, value] of Object.entries(collection("useCases"))) {
		if (!isObject(value)) continue;
		const implementation = isObject(value.implementation)
			? Array.isArray(value.implementation.steps)
				? "steps"
				: "code"
			: typeof value.generic === "string"
				? `standard:${value.generic}`
				: "unknown";
		const fields =
			isObject(value.input) && isObject(value.input.fields)
				? Object.keys(value.input.fields)
				: undefined;
		useCases[name] = {
			implementation,
			...(typeof value.description === "string"
				? { description: value.description }
				: {}),
			...(isObject(value.route) ? { route: value.route } : {}),
			...(isObject(value.access) ? { access: value.access } : {}),
			...(fields ? { input: fields } : {}),
		};
	}
	const commands: Record<string, Record<string, string>> = {};
	for (const [name, value] of Object.entries(collection("commands"))) {
		const entries: Record<string, string> = {};
		if (isObject(value) && isObject(value.useCases)) {
			for (const [operation, useCase] of Object.entries(value.useCases)) {
				// An operation names a declared use case, or declares a standard one in place.
				if (typeof useCase === "string") entries[operation] = useCase;
				else if (isObject(useCase)) {
					const inline = `${name}.${operation}`;
					entries[operation] = inline;
					useCases[inline] = {
						implementation:
							typeof useCase.generic === "string"
								? `standard:${useCase.generic}`
								: "unknown",
						...(isObject(useCase.route) ? { route: useCase.route } : {}),
						...(isObject(useCase.access) ? { access: useCase.access } : {}),
					};
				}
			}
		}
		commands[name] = entries;
	}
	const outputs: Record<string, ProjectFacts["outputs"][string]> = {};
	for (const [name, value] of Object.entries(collection("outputs"))) {
		if (!isObject(value)) continue;
		outputs[name] = {
			commands: Array.isArray(value.commands)
				? (value.commands as string[])
				: [],
			stages: (Array.isArray(value.pipe) ? value.pipe : []).map((stage) => {
				const entry = isObject(stage) ? stage : {};
				const kind = typeof entry.sink === "string" ? "sink" : "transform";
				const stageName = entry.sink ?? entry.transform;
				return {
					kind: typeof entry.import === "string" ? "opaque" : kind,
					...(typeof stageName === "string" ? { name: stageName } : {}),
					...(isObject(entry.options) ? { options: entry.options } : {}),
				};
			}),
		};
	}
	return viewOf({
		...(typeof source.name === "string" ? { name: source.name } : {}),
		entities: collection("entities") as Record<string, Json>,
		repositories: collection("repositories") as Record<string, Json>,
		useCases,
		commands,
		outputs,
	});
}

/** The view of a running application, from what its `describe()` gives. */
export function projectViewOfDescription(description: unknown): ProjectView {
	const source = isObject(description) ? description : {};
	const collection = (key: string): Json =>
		isObject(source[key]) ? (source[key] as Json) : {};
	const useCases: Record<string, UseCaseFacts> = {};
	for (const [name, value] of Object.entries(collection("useCases"))) {
		if (!isObject(value)) continue;
		const generic = isObject(value.generic) ? value.generic.name : undefined;
		const kind = isObject(value.implementation)
			? value.implementation.kind
			: undefined;
		useCases[name] = {
			implementation:
				typeof generic === "string"
					? `standard:${generic}`
					: kind === "steps"
						? "steps"
						: "code",
			...(typeof value.description === "string"
				? { description: value.description }
				: {}),
			...(isObject(value.route) ? { route: value.route } : {}),
			...(isObject(value.access) ? { access: value.access } : {}),
			...(isObject(value.input) ? { input: Object.keys(value.input) } : {}),
		};
	}
	const commands: Record<string, Record<string, string>> = {};
	for (const [name, value] of Object.entries(collection("commands"))) {
		const entries: Record<string, string> = {};
		if (isObject(value) && isObject(value.operations)) {
			for (const [operation, target] of Object.entries(value.operations)) {
				if (isObject(target) && typeof target.ref === "string") {
					entries[operation] = target.ref;
				}
			}
		}
		commands[name] = entries;
	}
	const outputs: Record<string, ProjectFacts["outputs"][string]> = {};
	for (const [name, value] of Object.entries(collection("outputs"))) {
		if (!isObject(value)) continue;
		outputs[name] = {
			commands: Array.isArray(value.commands)
				? (value.commands as string[])
				: [],
			stages: (Array.isArray(value.pipe) ? value.pipe : []).map((stage) => {
				const entry = isObject(stage) ? stage : {};
				return {
					kind: String(entry.kind ?? "opaque"),
					...(typeof entry.name === "string" ? { name: entry.name } : {}),
					...(isObject(entry.options) ? { options: entry.options } : {}),
				};
			}),
		};
	}
	const entities: Record<string, Json> = {};
	for (const [name, value] of Object.entries(collection("entities"))) {
		if (!isObject(value)) continue;
		entities[name] = { fields: value.fields, plugins: value.plugins };
	}
	const repositories: Record<string, Json> = {};
	for (const [name, value] of Object.entries(collection("repositories"))) {
		if (!isObject(value)) continue;
		repositories[name] = { entity: value.entity, actions: value.actions };
	}
	return viewOf({
		...(typeof source.name === "string" ? { name: source.name } : {}),
		entities,
		repositories,
		useCases,
		commands,
		outputs,
	});
}
