import { isRecordClass } from "../../blueprint/record-field";
import type { AnyBlueprint } from "../../blueprint/types/blueprint.interface";
import { isEnvironment } from "../../environment/environment";
import { isDeclaredException } from "../../exception/exception";
import { isRepository } from "../../repository/repository";
import { Kind } from "../../symbols/kind";
import { InvalidUseCaseStep } from "../exceptions";
import {
	isPlain,
	isStepName,
	parseReference,
	RESERVED_NAMES,
	walkValue,
} from "./references";

/** What `validateSteps` needs to know of the use case being declared. */
export interface StepsDeclaration {
	readonly name: string;
	readonly blueprint: AnyBlueprint;
	readonly context: AnyBlueprint | undefined;
	readonly dependencies: Readonly<Record<string, unknown>>;
	readonly errors: readonly unknown[];
}

/** The kind of each step, with the fields it requires and those it may add. */
const SHAPES = {
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

type StepKind = keyof typeof SHAPES;
const KINDS = Object.keys(SHAPES) as StepKind[];

const ENSURE_KINDS = new Set([
	"exists",
	"absent",
	"equals",
	"notEquals",
	"true",
	"false",
]);
const READ_ACTION =
	/^(?:findBy.+|findManyBy.+|findMany|exists|findPage|count)$/;
const WRITE_ACTIONS = new Set(["create", "update", "delete"]);

/** What is known of a name bound by a step: the class `build` made, if known. */
interface Bound {
	readonly record: object | undefined;
}

/**
 * Checks `steps` against the declaration of a use case and throws
 * `InvalidUseCaseStep` (`details: { index, reason, code }`) on the first
 * thing wrong: an unknown kind, a missing or extra field, a bad name, a
 * reference to what is not declared or bound yet, an action the repository
 * lacks, an error not in `errors`, or a missing, repeated or misplaced `return`.
 */
export function validateSteps(
	declaration: StepsDeclaration,
	steps: unknown,
): void {
	const { name } = declaration;
	const fail = (index: number, code: string, reason: string): never => {
		throw new InvalidUseCaseStep({
			source: name,
			details: { index, reason, code },
		});
	};
	if (!Array.isArray(steps) || steps.length === 0) {
		fail(0, "missing_return", "Expected steps to be a list ending in return.");
	}
	const list = steps as readonly unknown[];
	const bound = new Map<string, Bound>();
	const runs = new Set<string>();
	let returned = false;

	const useCaseDependency = (key: unknown): unknown =>
		typeof key === "string" && Object.hasOwn(declaration.dependencies, key)
			? declaration.dependencies[key]
			: undefined;

	const checkReference = (index: number, text: string): void => {
		const reference = parseReference(text);
		if (!reference) {
			fail(index, "invalid_reference", `"${text}" is not a valid reference.`);
			return;
		}
		const { root, path } = reference;
		const firstKey = path[0];
		if (root === "input" || root === "context") {
			const blueprint =
				root === "input" ? declaration.blueprint : declaration.context;
			if (blueprint === undefined) {
				fail(
					index,
					"invalid_reference",
					`"${text}" uses $context, but the use case declares no context.`,
				);
				return;
			}
			if (
				firstKey !== undefined &&
				!Object.hasOwn(blueprint.properties, firstKey)
			) {
				fail(
					index,
					"unknown_key",
					`"${text}" names "${firstKey}", which the ${root} does not declare.`,
				);
			}
			return;
		}
		if (root === "env") {
			if (
				firstKey === undefined ||
				!isEnvironment(useCaseDependency(firstKey))
			) {
				fail(
					index,
					"unknown_dependency",
					`"${text}" must name an environment dependency.`,
				);
			}
			return;
		}
		if (RESERVED_NAMES.includes(root)) {
			fail(index, "invalid_reference", `"${root}" is reserved.`);
			return;
		}
		if (!bound.has(root)) {
			fail(
				index,
				"unbound_reference",
				`"${text}" uses "${root}", which no earlier step binds.`,
			);
		}
	};

	const checkValue = (index: number, value: unknown, field: string): void => {
		walkValue(
			value,
			(_reference, text) => checkReference(index, text),
			(issue, text) =>
				fail(
					index,
					issue,
					issue === "invalid_reference"
						? `"${text}" is not a valid reference.`
						: `${field} must hold only JSON values and references.`,
				),
		);
	};

	const checkArgs = (index: number, args: unknown): void => {
		if (args === undefined) return;
		if (!Array.isArray(args)) {
			fail(index, "invalid_step", "args must be a list of values.");
		}
		checkValue(index, args, "args");
	};

	const checkTarget = (index: number, target: unknown, kind: string): void => {
		if (typeof target !== "string" || !target.startsWith("$")) {
			fail(index, "invalid_reference", `${kind} must be a reference.`);
			return;
		}
		checkReference(index, target);
	};

	const repositoryOf = (
		index: number,
		key: unknown,
		action: string,
	): { actions: readonly string[] } => {
		const dependency = useCaseDependency(key);
		if (!isRepository(dependency)) {
			return fail(
				index,
				"unknown_dependency",
				`"${String(key)}" is not a repository dependency.`,
			);
		}
		const actions = (dependency as { actions: readonly string[] }).actions;
		if (!actions.includes(action)) {
			fail(
				index,
				"unknown_action",
				`The repository "${String(key)}" has no "${action}" action.`,
			);
		}
		return { actions };
	};

	for (const [index, step] of list.entries()) {
		if (!isPlain(step) || Array.isArray(step)) {
			fail(index, "unknown_step", "A step must be an object.");
		}
		const record = step as Record<string, unknown>;
		const kinds = KINDS.filter((kind) => Object.hasOwn(record, kind));
		if (kinds.length !== 1) {
			fail(
				index,
				"unknown_step",
				kinds.length === 0
					? `Unknown step; expected one of ${KINDS.join(", ")}.`
					: `A step has one kind, found ${kinds.join(" and ")}.`,
			);
		}
		const kind = kinds[0] as StepKind;
		const shape = SHAPES[kind] as {
			readonly required: readonly string[];
			readonly optional: readonly string[];
		};
		for (const key of shape.required) {
			if (!Object.hasOwn(record, key) || record[key] === undefined) {
				fail(index, "invalid_step", `A ${kind} step needs "${key}".`);
			}
		}
		for (const key of Object.keys(record)) {
			if (!shape.required.includes(key) && !shape.optional.includes(key)) {
				fail(index, "invalid_step", `A ${kind} step has no "${key}".`);
			}
		}
		const as = record.as;
		if (as !== undefined) {
			if (!isStepName(as) || RESERVED_NAMES.includes(as) || bound.has(as)) {
				fail(
					index,
					"invalid_step_name",
					`"${String(as)}" must be an identifier, not reserved, bound once.`,
				);
			}
		}
		let knownRecord: object | undefined;
		switch (kind) {
			case "find": {
				const target = record.find;
				const parts = typeof target === "string" ? target.split(".") : [];
				const [repository, action] = parts;
				if (parts.length !== 2 || !repository || !action) {
					fail(index, "invalid_step", 'find must be "<repository>.<action>".');
				}
				if (WRITE_ACTIONS.has(action as string)) {
					fail(index, "write_in_find", `find cannot call "${action}".`);
				}
				if (!READ_ACTION.test(action as string)) {
					fail(index, "unknown_action", `"${action}" is not a read action.`);
				}
				repositoryOf(index, repository, action as string);
				checkArgs(index, record.args);
				break;
			}
			case "ensure": {
				if (!ENSURE_KINDS.has(record.ensure as string)) {
					fail(
						index,
						"invalid_step",
						`ensure must be one of ${[...ENSURE_KINDS].join(", ")}.`,
					);
				}
				const compares =
					record.ensure === "equals" || record.ensure === "notEquals";
				if (compares && record.other === undefined) {
					fail(index, "invalid_step", `ensure "${record.ensure}" needs other.`);
				}
				if (!compares && record.other !== undefined) {
					fail(
						index,
						"invalid_step",
						`ensure "${String(record.ensure)}" has no other.`,
					);
				}
				if (
					!isDeclaredException(record.error) ||
					!declaration.errors.includes(record.error)
				) {
					fail(
						index,
						"undeclared_error",
						"ensure.error must be a class made by exceptionOf, listed in errors.",
					);
				}
				checkValue(index, record.value, "value");
				if (record.other !== undefined)
					checkValue(index, record.other, "other");
				if (record.details !== undefined) {
					checkValue(index, record.details, "details");
				}
				break;
			}
			case "build": {
				if (!isRecordClass(record.build)) {
					fail(
						index,
						"invalid_class",
						"build must be a record or entity class.",
					);
				}
				const values = record.values;
				if (
					!(typeof values === "string" && values.startsWith("$")) &&
					!isPlain(values)
				) {
					fail(
						index,
						"invalid_step",
						"build.values must be a mapping or a reference.",
					);
				}
				checkValue(index, values, "values");
				knownRecord = record.build as object;
				break;
			}
			case "change": {
				checkTarget(index, record.change, "change");
				if (typeof record.key !== "string" || record.key === "") {
					fail(index, "invalid_step", "change.key must be a string.");
				}
				const reference = parseReference(record.change as string);
				const known =
					reference && reference.path.length === 0
						? bound.get(reference.root)?.record
						: undefined;
				if (known) {
					const keys =
						(known as { options?: { change?: readonly string[] } }).options
							?.change ?? [];
					if (!keys.includes(record.key as string)) {
						fail(
							index,
							"invalid_change_key",
							`"${String(record.key)}" is not a change key of ${(known as { name: string }).name}.`,
						);
					}
				}
				checkValue(index, record.value, "value");
				knownRecord = known;
				break;
			}
			case "invoke": {
				checkTarget(index, record.invoke, "invoke");
				if (typeof record.method !== "string" || record.method === "") {
					fail(index, "invalid_step", "invoke.method must be a string.");
				}
				checkArgs(index, record.args);
				break;
			}
			case "create":
			case "update":
			case "delete": {
				repositoryOf(index, record[kind], kind);
				checkValue(index, record.value, "value");
				break;
			}
			case "call": {
				const dependency = useCaseDependency(record.call);
				if (
					typeof dependency !== "function" ||
					(dependency as unknown as { [Kind]?: unknown })[Kind] !== "use-case"
				) {
					fail(
						index,
						"unknown_dependency",
						`"${String(record.call)}" is not a use case dependency.`,
					);
				}
				checkValue(index, record.input, "input");
				break;
			}
			case "run": {
				const runName = record.run;
				if (!isStepName(runName) || runs.has(runName)) {
					fail(
						index,
						"invalid_step_name",
						`run "${String(runName)}" must be an identifier, unique in the use case.`,
					);
				}
				if (typeof record.fn !== "function") {
					fail(index, "invalid_step", "run.fn must be a function.");
				}
				runs.add(runName as string);
				checkArgs(index, record.args);
				break;
			}
			case "return": {
				checkValue(index, record.return, "return");
				returned = true;
				if (index !== list.length - 1) {
					fail(
						index,
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
		fail(list.length, "missing_return", "The steps must end with return.");
	}
}
