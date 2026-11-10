import { catalog, recordPlugin } from "./catalog";
import { fieldsOfDecl } from "./graph";
import type { Field } from "./model";
import { checkImport, isImportObject } from "./provider";
import { type Decl, issue, type Scope } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";

type Path = readonly (string | number)[];

/** The kind of each step, with the fields it requires and those it may add. */
const STEP_SHAPES = {
	find: { required: ["find"], optional: ["args", "as"] },
	ensure: {
		required: ["ensure", "value", "error"],
		optional: ["other", "details"],
	},
	build: { required: ["build", "values", "as"], optional: [] },
	change: { required: ["change", "key", "value"], optional: ["as"] },
	invoke: { required: ["invoke", "method"], optional: ["args", "as"] },
	create: { required: ["create", "value"], optional: ["as"] },
	update: { required: ["update", "value"], optional: ["as"] },
	delete: { required: ["delete", "value"], optional: ["as"] },
	call: { required: ["call", "input"], optional: ["as"] },
	run: { required: ["run", "fn"], optional: ["args", "as"] },
	return: { required: ["return"], optional: [] },
} as const;

type StepKind = keyof typeof STEP_SHAPES;
const STEP_KINDS = Object.keys(STEP_SHAPES) as StepKind[];

const ENSURE_KINDS = [
	"exists",
	"absent",
	"equals",
	"notEquals",
	"true",
	"false",
];
const READ_ACTION =
	/^(?:findBy.+|findManyBy.+|findMany|exists|findPage|count)$/;
const WRITE_ACTIONS = new Set(["create", "update", "delete"]);
/** The names a step cannot bind with `as`: they are roots or escapes of values. */
const RESERVED_NAMES = ["input", "context", "env", "literal"];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/;

const isStepName = (value: unknown): value is string =>
	typeof value === "string" && IDENTIFIER.test(value);

/** Splits `$root.a.0.b`; `undefined` when `text` is not a well-formed reference. */
function parseReference(
	text: string,
): { root: string; path: string[] } | undefined {
	if (!text.startsWith("$")) return undefined;
	const [root, ...path] = text.slice(1).split(".");
	if (
		root !== undefined &&
		IDENTIFIER.test(root) &&
		path.every((segment) => SEGMENT.test(segment))
	) {
		return { root, path };
	}
	return undefined;
}

const isLiteralEscape = (value: unknown): boolean =>
	isObject(value) &&
	Object.keys(value).length === 1 &&
	Object.hasOwn(value, "literal");

/** Visits the references of a value; reports what cannot be a value. */
function walkValue(
	value: unknown,
	onReference: (text: string) => void,
	onIssue: (code: "invalid_value" | "invalid_reference", text: string) => void,
): void {
	if (typeof value === "string") {
		if (!value.startsWith("$")) return;
		if (parseReference(value)) onReference(value);
		else onIssue("invalid_reference", value);
		return;
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (isLiteralEscape(value)) return;
	if (Array.isArray(value)) {
		for (const item of value) walkValue(item, onReference, onIssue);
		return;
	}
	if (isObject(value)) {
		for (const item of Object.values(value)) {
			walkValue(item, onReference, onIssue);
		}
		return;
	}
	onIssue("invalid_value", String(value));
}

// ---------------------------------------------------------------- blueprints

/** What `input`, `response` or `context` is: a blueprint by name, or fields in place. */
type BlueprintRef =
	| { readonly kind: "named"; readonly name: string; readonly decl: Decl }
	| { readonly kind: "inline"; readonly fields: Record<string, Field> };

/** Checks `fields` declared in place; gives them parsed. Supplied by the validator. */
export type InlineChecker = (
	value: unknown,
	path: Path,
) => Record<string, Field> | undefined;

export function checkBlueprintRef(
	value: unknown,
	path: Path,
	scope: Scope,
	inline: InlineChecker,
	issues: SpecIssue[],
): BlueprintRef | undefined {
	if (typeof value === "string") {
		const decl = scope.decls.get(value);
		if (decl?.kind !== "blueprint") {
			issues.push(
				issue(
					path,
					decl ? "wrong_kind" : "unknown_blueprint",
					decl
						? `"${value}" is a ${decl.kind}; expected a blueprint.`
						: `"${value}" is not a declared blueprint. Name one, or write { "fields": {...} }.`,
				),
			);
			return undefined;
		}
		return { kind: "named", name: value, decl };
	}
	if (isObject(value) && Object.keys(value).every((key) => key === "fields")) {
		const fields = inline(value.fields, [...path, "fields"]);
		return fields ? { kind: "inline", fields } : undefined;
	}
	issues.push(
		issue(
			path,
			"invalid_blueprint",
			'Expected the name of a blueprint or { "fields": {...} }.',
		),
	);
	return undefined;
}

// ---------------------------------------------------------------- exceptions

/** Checks one `exceptions` declaration. */
export function checkException(decl: Decl, issues: SpecIssue[]): void {
	const path = ["exceptions", decl.name];
	const { spec } = decl;
	for (const key of Object.keys(spec)) {
		if (key !== "layer" && key !== "message") {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: layer, message.`,
				),
			);
		}
	}
	const layers = catalog().exceptionLayers;
	if (typeof spec.layer !== "string" || !layers.includes(spec.layer)) {
		issues.push(
			issue(
				[...path, "layer"],
				"invalid_layer",
				`"layer" must be one of: ${layers.join(", ")}.`,
			),
		);
	}
	if (
		spec.message !== undefined &&
		(typeof spec.message !== "string" || spec.message === "")
	) {
		issues.push(
			issue(
				[...path, "message"],
				"invalid_message",
				'"message" must be a non-empty string.',
			),
		);
	}
}

// ---------------------------------------------------------------- use cases

/** The name of an exception a step or `errors` mentions, if it is a valid reference to one. */
export function errorNameOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (
		isObject(value) &&
		Object.keys(value).length === 1 &&
		typeof value.core === "string"
	) {
		return value.core;
	}
	return undefined;
}

/** Whether `name` is an exception declared in the spec, or exported by the core. */
function isKnownException(name: string, scope: Scope): boolean {
	return (
		scope.decls.get(name)?.kind === "exception" ||
		catalog().coreExceptions.includes(name)
	);
}

/** The change keys of a record or entity declaration: its own and its plugins'. */
function changeKeysOf(decl: Decl): string[] {
	const own = Array.isArray(decl.spec.change)
		? decl.spec.change.filter((key): key is string => typeof key === "string")
		: [];
	const plugins = Array.isArray(decl.spec.plugins) ? decl.spec.plugins : [];
	return [
		...own,
		...plugins.flatMap((name) =>
			typeof name === "string" ? (recordPlugin(name)?.change ?? []) : [],
		),
	];
}

/** Whether a use case declaration is implemented by a hand-written class. */
export function isImported(spec: Record<string, unknown>): boolean {
	return isObject(spec.implementation) && isImportObject(spec.implementation);
}

/** Checks one `useCases` declaration: metadata, references and the steps. */
export function checkUseCase(
	decl: Decl,
	scope: Scope,
	inline: InlineChecker,
	issues: SpecIssue[],
): void {
	const path: Path = ["useCases", decl.name];
	const { spec } = decl;
	const allowed = [
		"description",
		"tags",
		"deprecated",
		"input",
		"response",
		"context",
		"dependencies",
		"errors",
		"implementation",
	];
	for (const key of Object.keys(spec)) {
		if (!allowed.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: ${allowed.join(", ")}.`,
				),
			);
		}
	}
	if (spec.description !== undefined && typeof spec.description !== "string") {
		issues.push(
			issue(
				[...path, "description"],
				"invalid_option",
				'"description" must be a string.',
			),
		);
	}
	if (spec.deprecated !== undefined && typeof spec.deprecated !== "boolean") {
		issues.push(
			issue(
				[...path, "deprecated"],
				"invalid_option",
				'"deprecated" must be a boolean.',
			),
		);
	}
	if (spec.tags !== undefined) {
		const tags = spec.tags;
		if (
			!Array.isArray(tags) ||
			tags.some((tag) => typeof tag !== "string" || tag === "") ||
			new Set(tags).size !== tags.length
		) {
			issues.push(
				issue(
					[...path, "tags"],
					"invalid_option",
					'"tags" must be distinct, non-empty strings.',
				),
			);
		}
	}

	const blueprint = (key: "input" | "response" | "context") => {
		if (spec[key] === undefined) {
			if (key !== "context") {
				issues.push(
					issue(
						[...path, key],
						"invalid_blueprint",
						`"${key}" is required: a blueprint name or { "fields": {...} }.`,
					),
				);
			}
			return undefined;
		}
		return checkBlueprintRef(spec[key], [...path, key], scope, inline, issues);
	};
	const input = blueprint("input");
	blueprint("response");
	const context = blueprint("context");
	const keysOf = (ref: BlueprintRef | undefined): Set<string> | undefined => {
		if (!ref) return undefined;
		const fields = ref.kind === "inline" ? ref.fields : fieldsOfDecl(ref.decl);
		return fields ? new Set(Object.keys(fields)) : undefined;
	};
	const inputKeys = keysOf(input);
	const contextKeys = keysOf(context);

	// dependencies
	const dependencies = new Map<string, Decl>();
	if (spec.dependencies !== undefined) {
		if (!isObject(spec.dependencies)) {
			issues.push(
				issue(
					[...path, "dependencies"],
					"invalid_dependencies",
					'"dependencies" must be an object of key -> declaration name.',
				),
			);
		} else {
			for (const [key, name] of Object.entries(spec.dependencies)) {
				const here = [...path, "dependencies", key];
				if (!isIdentifier(key)) {
					issues.push(
						issue(here, "invalid_key", `"${key}" is not a valid key.`),
					);
					continue;
				}
				const target =
					typeof name === "string" ? scope.decls.get(name) : undefined;
				// The core's `Logger`: nothing to declare, and no step reads it.
				if (name === "Logger" && target === undefined) continue;
				if (
					target?.kind !== "useCase" &&
					target?.kind !== "repository" &&
					target?.kind !== "environment"
				) {
					issues.push(
						issue(
							here,
							target ? "wrong_kind" : "unknown_dependency",
							target
								? `"${name}" is a ${target.kind}; a dependency is a use case, a repository, an environment or "Logger".`
								: `"${String(name)}" is not a declared use case, repository or environment, nor "Logger".`,
						),
					);
					continue;
				}
				if (target.kind === "useCase" && target.name === decl.name) {
					issues.push(
						issue(here, "cycle", "A use case cannot depend on itself."),
					);
					continue;
				}
				if (
					target.kind === "useCase" &&
					target.via === undefined &&
					isImported(target.spec)
				) {
					issues.push(
						issue(
							here,
							"import_dependency",
							`"${target.name}" is implemented by a hand-written class, which imports the generated file that would import it back. Make it a steps use case, or call it through a step of a use case that does not need it as a dependency.`,
						),
					);
					continue;
				}
				dependencies.set(key, target);
			}
		}
	}

	// errors
	const errors: string[] = [];
	if (spec.errors !== undefined) {
		if (
			!Array.isArray(spec.errors) ||
			!spec.errors.every((item) => typeof item === "string")
		) {
			issues.push(
				issue(
					[...path, "errors"],
					"invalid_option",
					'"errors" must be an array of exception names.',
				),
			);
		} else {
			for (const [index, name] of (spec.errors as string[]).entries()) {
				const here = [...path, "errors", index];
				if (!isKnownException(name, scope)) {
					issues.push(
						issue(
							here,
							"unknown_exception",
							`"${name}" is not a declared exception nor one exported by @afora/core (see afora_catalog coreExceptions).`,
						),
					);
				} else if (errors.includes(name)) {
					issues.push(
						issue(here, "duplicate_error", `"${name}" is listed twice.`),
					);
				} else errors.push(name);
			}
		}
	}

	// implementation
	const implementation = spec.implementation;
	const implPath = [...path, "implementation"];
	if (!isObject(implementation)) {
		issues.push(
			issue(
				implPath,
				"invalid_implementation",
				'"implementation" is { "steps": [...] } or { "import": "./file.ts#Class" }.',
			),
		);
		return;
	}
	if (isImportObject(implementation)) {
		checkImport(implementation, implPath, issues);
		if (scope.decls.has(`${decl.name}Base`)) {
			issues.push(
				issue(
					implPath,
					"name_collision",
					`"${decl.name}Base" is the generated base of "${decl.name}" and is already a declaration.`,
				),
			);
		}
		return;
	}
	for (const key of Object.keys(implementation)) {
		if (key !== "steps") {
			issues.push(
				issue(
					[...implPath, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: steps (or import).`,
				),
			);
		}
	}
	checkSteps(implementation.steps, implPath, {
		scope,
		inputKeys,
		contextKeys,
		hasContext: context !== undefined,
		dependencies,
		errors,
		issues,
	});
}

interface StepsContext {
	readonly scope: Scope;
	readonly inputKeys: Set<string> | undefined;
	readonly contextKeys: Set<string> | undefined;
	readonly hasContext: boolean;
	readonly dependencies: ReadonlyMap<string, Decl>;
	readonly errors: readonly string[];
	readonly issues: SpecIssue[];
}

function checkSteps(steps: unknown, implPath: Path, ctx: StepsContext): void {
	const { scope, issues } = ctx;
	const stepsPath = [...implPath, "steps"];
	if (!Array.isArray(steps) || steps.length === 0) {
		issues.push(
			issue(
				stepsPath,
				"missing_return",
				'"steps" must be a non-empty list ending in { "return": ... }.',
			),
		);
		return;
	}
	const bound = new Map<string, { record: Decl | undefined }>();
	const runs = new Set<string>();
	let returned = false;

	for (const [index, step] of steps.entries()) {
		const here = [...stepsPath, index];
		const fail = (code: string, message: string, key?: string): void => {
			issues.push(issue(key ? [...here, key] : here, code, message));
		};

		const checkReference = (text: string, key: string): void => {
			const reference = parseReference(text);
			if (!reference) {
				fail("invalid_reference", `"${text}" is not a valid reference.`, key);
				return;
			}
			const { root, path } = reference;
			const first = path[0];
			if (root === "input" || root === "context") {
				if (root === "context" && !ctx.hasContext) {
					fail(
						"invalid_reference",
						`"${text}" uses $context, but the use case declares no context.`,
						key,
					);
					return;
				}
				const keys = root === "input" ? ctx.inputKeys : ctx.contextKeys;
				if (first !== undefined && keys && !keys.has(first)) {
					fail(
						"unknown_key",
						`"${text}" names "${first}", which the ${root} does not declare.`,
						key,
					);
				}
				return;
			}
			if (root === "env") {
				if (
					first === undefined ||
					ctx.dependencies.get(first)?.kind !== "environment"
				) {
					fail(
						"unknown_dependency",
						`"${text}" must name an environment dependency.`,
						key,
					);
				}
				return;
			}
			if (RESERVED_NAMES.includes(root)) {
				fail("invalid_reference", `"${root}" is reserved.`, key);
				return;
			}
			if (!bound.has(root)) {
				fail(
					"unbound_reference",
					`"${text}" uses "${root}", which no earlier step binds.`,
					key,
				);
			}
		};
		const checkValue = (value: unknown, key: string): void =>
			walkValue(
				value,
				(text) => checkReference(text, key),
				(code, text) =>
					fail(
						code,
						code === "invalid_reference"
							? `"${text}" is not a valid reference.`
							: `${key} must hold only JSON values and references.`,
						key,
					),
			);
		const checkArgs = (args: unknown): void => {
			if (args === undefined) return;
			if (!Array.isArray(args)) {
				fail("invalid_step", "args must be a list of values.", "args");
				return;
			}
			checkValue(args, "args");
		};
		const checkTarget = (target: unknown, key: string): void => {
			if (typeof target !== "string" || !target.startsWith("$")) {
				fail("invalid_reference", `${key} must be a reference.`, key);
				return;
			}
			checkReference(target, key);
		};
		const repository = (key: unknown, action: string, field: string): void => {
			const dependency =
				typeof key === "string" ? ctx.dependencies.get(key) : undefined;
			if (dependency?.kind !== "repository") {
				fail(
					"unknown_dependency",
					`"${String(key)}" is not a repository dependency.`,
					field,
				);
				return;
			}
			const actions = Array.isArray(dependency.spec.actions)
				? dependency.spec.actions
				: [];
			if (!actions.includes(action)) {
				fail(
					"unknown_action",
					`The repository "${String(key)}" (${dependency.name}) has no "${action}" action.`,
					field,
				);
			}
		};

		if (!isObject(step)) {
			fail("unknown_step", "A step must be an object.");
			continue;
		}
		const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(step, kind));
		if (kinds.length !== 1) {
			fail(
				"unknown_step",
				kinds.length === 0
					? `Unknown step; expected one of ${STEP_KINDS.join(", ")}.`
					: `A step has one kind, found ${kinds.join(" and ")}.`,
			);
			continue;
		}
		const kind = kinds[0] as StepKind;
		const shape = STEP_SHAPES[kind] as {
			readonly required: readonly string[];
			readonly optional: readonly string[];
		};
		let shapeOk = true;
		for (const key of shape.required) {
			if (!Object.hasOwn(step, key) || step[key] === undefined) {
				fail("invalid_step", `A ${kind} step needs "${key}".`);
				shapeOk = false;
			}
		}
		for (const key of Object.keys(step)) {
			if (!shape.required.includes(key) && !shape.optional.includes(key)) {
				fail("invalid_step", `A ${kind} step has no "${key}".`, key);
				shapeOk = false;
			}
		}
		if (!shapeOk) continue;
		const as = step.as;
		if (as !== undefined) {
			if (!isStepName(as) || RESERVED_NAMES.includes(as) || bound.has(as)) {
				fail(
					"invalid_step_name",
					`"${String(as)}" must be an identifier, not reserved, bound once.`,
					"as",
				);
			}
		}
		let knownRecord: Decl | undefined;
		switch (kind) {
			case "find": {
				const target = step.find;
				const parts = typeof target === "string" ? target.split(".") : [];
				const [repo, action] = parts;
				if (parts.length !== 2 || !repo || !action) {
					fail("invalid_step", 'find must be "<repository>.<action>".', "find");
				} else if (WRITE_ACTIONS.has(action)) {
					fail("write_in_find", `find cannot call "${action}".`, "find");
				} else if (!READ_ACTION.test(action)) {
					fail("unknown_action", `"${action}" is not a read action.`, "find");
				} else repository(repo, action, "find");
				checkArgs(step.args);
				break;
			}
			case "ensure": {
				if (!ENSURE_KINDS.includes(step.ensure as string)) {
					fail(
						"invalid_step",
						`ensure must be one of ${ENSURE_KINDS.join(", ")}.`,
						"ensure",
					);
				}
				const compares =
					step.ensure === "equals" || step.ensure === "notEquals";
				if (compares && step.other === undefined) {
					fail("invalid_step", `ensure "${step.ensure}" needs other.`);
				}
				if (!compares && step.other !== undefined) {
					fail(
						"invalid_step",
						`ensure "${String(step.ensure)}" has no other.`,
						"other",
					);
				}
				const name = errorNameOf(step.error);
				if (name === undefined || !isKnownException(name, scope)) {
					fail(
						"unknown_exception",
						'ensure.error must name a declared exception or a core one (a string, or { "core": "Name" }).',
						"error",
					);
				} else if (!ctx.errors.includes(name)) {
					fail(
						"undeclared_error",
						`ensure.error "${name}" must be listed in the use case's errors.`,
						"error",
					);
				}
				checkValue(step.value, "value");
				if (step.other !== undefined) checkValue(step.other, "other");
				if (step.details !== undefined) checkValue(step.details, "details");
				break;
			}
			case "build": {
				const target =
					typeof step.build === "string"
						? scope.decls.get(step.build)
						: undefined;
				if (target?.kind !== "record" && target?.kind !== "entity") {
					fail(
						"invalid_class",
						"build must name a declared record or entity.",
						"build",
					);
				} else knownRecord = target;
				const values = step.values;
				if (
					!(typeof values === "string" && values.startsWith("$")) &&
					!isObject(values)
				) {
					fail(
						"invalid_step",
						"build.values must be a mapping or a reference.",
						"values",
					);
				}
				checkValue(values, "values");
				break;
			}
			case "change": {
				checkTarget(step.change, "change");
				if (typeof step.key !== "string" || step.key === "") {
					fail("invalid_step", "change.key must be a string.", "key");
				}
				const reference =
					typeof step.change === "string"
						? parseReference(step.change)
						: undefined;
				const known =
					reference && reference.path.length === 0
						? bound.get(reference.root)?.record
						: undefined;
				if (
					known &&
					typeof step.key === "string" &&
					!changeKeysOf(known).includes(step.key)
				) {
					fail(
						"invalid_change_key",
						`"${step.key}" is not a change key of ${known.name}.`,
						"key",
					);
				}
				checkValue(step.value, "value");
				knownRecord = known;
				break;
			}
			case "invoke": {
				checkTarget(step.invoke, "invoke");
				if (typeof step.method !== "string" || step.method === "") {
					fail("invalid_step", "invoke.method must be a string.", "method");
				}
				checkArgs(step.args);
				break;
			}
			case "create":
			case "update":
			case "delete": {
				repository(step[kind], kind, kind);
				checkValue(step.value, "value");
				break;
			}
			case "call": {
				if (
					typeof step.call !== "string" ||
					ctx.dependencies.get(step.call)?.kind !== "useCase"
				) {
					fail(
						"unknown_dependency",
						`"${String(step.call)}" is not a use case dependency.`,
						"call",
					);
				}
				checkValue(step.input, "input");
				break;
			}
			case "run": {
				const runName = step.run;
				if (!isStepName(runName) || runs.has(runName)) {
					fail(
						"invalid_step_name",
						`run "${String(runName)}" must be an identifier, unique in the use case.`,
						"run",
					);
				} else runs.add(runName);
				if (!isObject(step.fn) || !isImportObject(step.fn)) {
					fail(
						"invalid_import",
						'run.fn must be { "import": "./file.ts#function" }.',
						"fn",
					);
				} else {
					checkImport(step.fn, [...here, "fn"], issues);
				}
				checkArgs(step.args);
				break;
			}
			case "return": {
				checkValue(step.return, "return");
				returned = true;
				if (index !== steps.length - 1) {
					fail(
						"misplaced_return",
						"return must be the last step, exactly once.",
					);
				}
				break;
			}
		}
		if (typeof as === "string") bound.set(as, { record: knownRecord });
	}
	if (!returned) {
		issues.push(
			issue(
				[...stepsPath, steps.length],
				"missing_return",
				"The steps must end with return.",
			),
		);
	}
}
