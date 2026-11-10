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
import type { AnyExceptionClass } from "../../core/use-case/use-case";

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

const COMMON = ["name", "description", "tags", "deprecated", "errors"];

/** The name, description, tags and `deprecated` of the use case. */
export function metaOf(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
): Pick<UseCaseCompilation, "name" | "description" | "tags" | "deprecated"> {
	const { name, description, tags, deprecated } = options;
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

/** The id field of the entity of `target`. */
export const idOf = (target: UseCaseTargetInfo): BlueprintField =>
	target.field("id").field;

/** The classes of `errors`, each once. */
export const distinct = (
	...errors: readonly AnyExceptionClass[]
): AnyExceptionClass[] => [...new Set(errors)];

/**
 * A use case over one entity found by id: `{ id }` in, `{ [as]: entity }`
 * out; loads it, checks the owner, runs `steps` (which leave the entity to
 * give under `result`) and gives it.
 */
export function entityUseCase(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	allowed: readonly string[],
	steps: (context: { readonly owner: Owner | undefined }) => {
		readonly steps: readonly Step[];
		readonly result: string;
	},
): UseCaseCompilation {
	checkOptions(target, options, ["as", "owner", ...allowed]);
	const owner = ownerOf(target, options);
	const notFound = errorOf(target, options, "notFound", UseCaseEntityNotFound);
	const body = steps({ owner });
	return {
		...metaOf(target, options, verb),
		blueprint: fields(() => ({ id: idOf(target) })),
		response: fields(() => ({ [asOf(target, options)]: target.entity })),
		...contextOf(owner),
		dependencies: { repository: target.repository },
		errors: [notFound],
		steps: [
			...loadSteps(owner, notFound),
			...body.steps,
			{ return: { [asOf(target, options)]: body.result } },
		],
	};
}
