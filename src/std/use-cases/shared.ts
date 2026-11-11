import { blueprintBuilderOf } from "../../core/blueprint/blueprint";
import type { BlueprintField } from "../../core/blueprint/types/blueprint.interface";
import { isDeclaredException } from "../../core/exception/exception";
import { UseCaseEntityNotFound } from "../../core/use-case/exceptions";
import { isPlain } from "../../core/use-case/steps/references";
import type {
	UseCaseCompilation,
	UseCaseFieldPlan,
	UseCaseTargetInfo,
} from "../../core/use-case/types/plugin.interface";
import type {
	AnyExceptionClass,
	UseCaseDependency,
} from "../../core/use-case/use-case";

/** A blueprint of the fields given, with no context of properties. */
export const fields = blueprintBuilderOf();

export type Options = Readonly<Record<string, unknown>>;
export type Step = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const capitalize = (key: string): string =>
	`${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/** A value given in options as a step takes it: a string that starts with `$` is not a reference. */
export function literal(value: unknown): unknown {
	if (typeof value === "string") {
		return value.startsWith("$") ? { literal: value } : value;
	}
	if (Array.isArray(value)) return value.map(literal);
	if (isPlain(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, literal(item)]),
		);
	}
	return value;
}

/** The option `key`, checked to be one of the `allowed` options of the use case. */
export function checkOptions(
	target: UseCaseTargetInfo,
	options: Options,
	allowed: readonly string[],
): void {
	const known = [...COMMON, ...allowed];
	for (const key of Object.keys(options)) {
		if (!known.includes(key)) {
			target.unavailable(
				`it has no option "${key}" (options: ${known.join(", ")})`,
			);
		}
	}
}

const COMMON = [
	"name",
	"description",
	"tags",
	"deprecated",
	"errors",
	"route",
	"access",
];

/** The options of the use cases that write: `before`, `after`, `dependencies`, `throws`. */
export const HOOKS = ["before", "after", "dependencies", "throws"] as const;

/** The name, description, tags, `deprecated`, route and access of the use case. */
export function metaOf(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
): Pick<
	UseCaseCompilation,
	"name" | "description" | "tags" | "deprecated" | "route" | "access"
> {
	const { name, description, tags, deprecated, route, access } = options;
	if (name !== undefined && (typeof name !== "string" || name === "")) {
		target.unavailable("the option name must be a non-empty string");
	}
	return {
		name: (name as string | undefined) ?? `${verb}${target.entityName}`,
		...(description === undefined
			? {}
			: { description: description as string }),
		...(tags === undefined ? {} : { tags: tags as readonly string[] }),
		...(deprecated === undefined ? {} : { deprecated: deprecated as boolean }),
		// Checked by `useCaseOf`, against the input and the response it is given.
		...(route === undefined
			? {}
			: { route: route as UseCaseCompilation["route"] }),
		...(access === undefined
			? {}
			: { access: access as UseCaseCompilation["access"] }),
	};
}

/** The key of the response that holds the entity: the option `as`, `item` by default. */
export function asOf(target: UseCaseTargetInfo, options: Options): string {
	const { as = "item" } = options;
	if (typeof as !== "string" || !IDENTIFIER.test(as)) {
		target.unavailable("the option as must be an identifier");
	}
	return as as string;
}

/** The error of `kind` the options give, else `fallback`. */
export function errorOf(
	target: UseCaseTargetInfo,
	options: Options,
	kind: "notFound" | "conflict" | "invalid" | "owner",
	fallback: AnyExceptionClass,
): AnyExceptionClass {
	const { errors } = options;
	if (errors === undefined) return fallback;
	if (!isPlain(errors)) {
		return target.unavailable(
			"the option errors must be an object of exception classes",
		);
	}
	const given = errors[kind];
	if (given === undefined) return fallback;
	if (!isDeclaredException(given)) {
		return target.unavailable(
			`errors.${kind} must be a class made by exceptionOf`,
		);
	}
	return given as unknown as AnyExceptionClass;
}

/** The list of names an option gives, each a key of the entity. */
export function keysOf(
	target: UseCaseTargetInfo,
	options: Options,
	option: string,
): readonly UseCaseFieldPlan[] {
	const given = options[option];
	if (given === undefined) return [];
	if (!Array.isArray(given) || given.some((key) => typeof key !== "string")) {
		return target.unavailable(`the option ${option} must be a list of keys`);
	}
	return (given as readonly string[]).map((key) => target.field(key));
}

/** The object an option gives, by key of the entity. */
export function valuesOf(
	target: UseCaseTargetInfo,
	options: Options,
	option: string,
): Readonly<Record<string, unknown>> {
	const given = options[option];
	if (given === undefined) return {};
	if (!isPlain(given)) {
		return target.unavailable(`the option ${option} must be an object`);
	}
	for (const key of Object.keys(given)) {
		if (target.field(key).identity) {
			target.unavailable(`${option}.${key} is an identity key`);
		}
	}
	return given;
}

/** Who owns the entity, as the option `owner` says. */
export interface Owner {
	readonly plan: UseCaseFieldPlan;
	/** The key of the context that holds the id of the caller. */
	readonly context: string;
	/** The field of that context key: an id. */
	readonly field: BlueprintField;
	/** The reference to the id of the owner of the entity bound as `item`. */
	readonly reference: string;
}

/**
 * The option `owner: { key?, context }`: `key` (`ownerId` by default) holds
 * the owner, an id or an entity, and `context` names the context key with
 * the id of the caller.
 */
export function ownerOf(
	target: UseCaseTargetInfo,
	options: Options,
): Owner | undefined {
	const { owner } = options;
	if (owner === undefined) return undefined;
	if (
		!isPlain(owner) ||
		typeof owner.context !== "string" ||
		!IDENTIFIER.test(owner.context) ||
		(owner.key !== undefined && typeof owner.key !== "string")
	) {
		return target.unavailable(
			"the option owner must be { key?, context }, context naming a context key",
		);
	}
	const plan = target.field((owner.key as string | undefined) ?? "ownerId");
	if (plan.identity || plan.optional) {
		target.unavailable(`owner.key "${plan.key}" must be a required key`);
	}
	if (plan.kind === "entity" && plan.related) {
		return {
			plan,
			context: owner.context,
			field: plan.related.blueprint.properties.id as BlueprintField,
			reference: `$item.${plan.key}.id`,
		};
	}
	if (plan.kind !== "property") {
		target.unavailable(`owner.key "${plan.key}" must hold an id or an entity`);
	}
	return {
		plan,
		context: owner.context,
		field: plan.field,
		reference: `$item.${plan.key}`,
	};
}

/** The context blueprint an owner needs, if there is one. */
export function contextOf(
	owner: Owner | undefined,
): Pick<UseCaseCompilation, "context"> {
	return owner
		? { context: fields(() => ({ [owner.context]: owner.field })) }
		: {};
}

/**
 * The steps that load the entity of `$input.id` as `item`, throw `notFound`
 * when there is none, and when it is not the caller's.
 */
export function loadSteps(
	owner: Owner | undefined,
	notFound: AnyExceptionClass,
): Step[] {
	return [
		{ find: "repository.findById", args: ["$input.id"], as: "item" },
		{ ensure: "exists", value: "$item", error: notFound },
		...(owner
			? [
					{
						ensure: "equals",
						value: owner.reference,
						other: `$context.${owner.context}`,
						error: notFound,
					},
				]
			: []),
	];
}

type Hook = (args: Readonly<Record<string, unknown>>) => unknown;

/** What `run` gives a function after its args. */
interface RunOptions {
	readonly context: unknown;
	readonly dependencies: Readonly<Record<string, unknown>>;
}

/** What the options `before`, `after`, `dependencies` and `throws` add to a use case. */
export interface Hooks {
	/** The root of the input the steps read: `$input`, or `$prepared` after `before`. */
	readonly input: string;
	/** The dependencies the options give, joined to those the use case makes. */
	readonly dependencies: Readonly<Record<string, UseCaseDependency>>;
	readonly throws: readonly AnyExceptionClass[];
	/** The step of `before`, if any: it binds `prepared`, the input it gives back or the one it got. */
	before(entity?: string): Step[];
	/** The step of `after`, if any, over the entity written. */
	after(entity: string): Step[];
}

/**
 * The options `before`, `after`, `dependencies` and `throws`, checked: each
 * hook becomes a `run` step, whose function gets `{ input, entity?,
 * dependencies, context }` (the bound dependencies of the call, overrides
 * included).
 */
export function hooksOf(target: UseCaseTargetInfo, options: Options): Hooks {
	const { before, after, dependencies = {}, throws = [] } = options;
	for (const [key, hook] of [
		["before", before],
		["after", after],
	] as const) {
		if (hook !== undefined && typeof hook !== "function") {
			target.unavailable(`the option ${key} must be a function`);
		}
	}
	if (
		!isPlain(dependencies) ||
		Object.keys(dependencies).some((key) => !IDENTIFIER.test(key))
	) {
		target.unavailable(
			"the option dependencies must be an object of repositories, use cases or environments by name",
		);
	}
	if (
		!Array.isArray(throws) ||
		throws.some((error) => !isDeclaredException(error))
	) {
		target.unavailable(
			"the option throws must be a list of classes made by exceptionOf",
		);
	}
	const input = before === undefined ? "$input" : "$prepared";
	return {
		input,
		dependencies: dependencies as Readonly<Record<string, UseCaseDependency>>,
		throws: throws as readonly AnyExceptionClass[],
		before: (entity) =>
			before === undefined
				? []
				: [
						{
							run: "before",
							fn: async (given: unknown, ...rest: unknown[]) => {
								const { context, dependencies } = rest.at(-1) as RunOptions;
								const replaced = await (before as Hook)({
									input: given,
									...(entity === undefined ? {} : { entity: rest[0] }),
									dependencies,
									context,
								});
								return replaced === undefined ? given : replaced;
							},
							args: entity === undefined ? ["$input"] : ["$input", entity],
							as: "prepared",
						},
					],
		after: (entity) =>
			after === undefined
				? []
				: [
						{
							run: "after",
							fn: async (
								written: unknown,
								given: unknown,
								{ context, dependencies }: RunOptions,
							) => {
								await (after as Hook)({
									entity: written,
									input: given,
									dependencies,
									context,
								});
							},
							args: [entity, input],
						},
					],
	};
}

/**
 * The dependencies a use case makes, joined to those of the option
 * `dependencies`; a name taken by both is unavailable.
 */
export function joinDependencies(
	target: UseCaseTargetInfo,
	made: Readonly<Record<string, UseCaseDependency>>,
	hooks: Hooks,
): Readonly<Record<string, UseCaseDependency>> {
	for (const key of Object.keys(hooks.dependencies)) {
		if (Object.hasOwn(made, key)) {
			target.unavailable(
				`dependencies.${key} is a name the use case gives its own dependency`,
			);
		}
	}
	return { ...made, ...hooks.dependencies };
}

/** The id field of the entity of `target`. */
export const idOf = (target: UseCaseTargetInfo): BlueprintField =>
	target.field("id").field;

/** The classes of `errors`, each once. */
export const distinct = (
	...errors: readonly AnyExceptionClass[]
): AnyExceptionClass[] => [...new Set(errors)];

/**
 * A use case over one entity found by id: `{ id }` in, `{ [as]: entity }`
 * out; loads it, checks the owner, runs `before` (with `hooks`), `steps`
 * (which leave the entity to give under `result`) and `after`, and gives it.
 * `steps` read the input under `input`: `$input`, or what `before` gave.
 */
export function entityUseCase(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	allowed: readonly string[],
	steps: (context: {
		readonly owner: Owner | undefined;
		readonly input: string;
	}) => {
		readonly steps: readonly Step[];
		readonly result: string;
	},
	hooks = false,
): UseCaseCompilation {
	checkOptions(target, options, [
		"as",
		"owner",
		...allowed,
		...(hooks ? HOOKS : []),
	]);
	const owner = ownerOf(target, options);
	const notFound = errorOf(target, options, "notFound", UseCaseEntityNotFound);
	const hooked = hooksOf(target, options);
	const body = steps({ owner, input: hooked.input });
	return {
		...metaOf(target, options, verb),
		blueprint: fields(() => ({ id: idOf(target) })),
		response: fields(() => ({ [asOf(target, options)]: target.entity })),
		...contextOf(owner),
		dependencies: joinDependencies(
			target,
			{ repository: target.repository },
			hooked,
		),
		errors: distinct(notFound, ...hooked.throws),
		steps: [
			...loadSteps(owner, notFound),
			...hooked.before("$item"),
			...body.steps,
			...hooked.after(body.result),
			{ return: { [asOf(target, options)]: body.result } },
		],
	};
}
