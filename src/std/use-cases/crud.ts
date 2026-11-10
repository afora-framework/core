import { listOf } from "../../core/blueprint/list";
import { optionalOf } from "../../core/blueprint/optional";
import type { BlueprintField } from "../../core/blueprint/types/blueprint.interface";
import type { AnyRepository } from "../../core/repository/types/repository.interface";
import { UseCaseEntityNotFound } from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import type {
	UseCaseCompilation,
	UseCaseTargetInfo,
} from "../../core/use-case/types/plugin.interface";
import type { AnyExceptionClass } from "../../core/use-case/use-case";
import { Integer } from "../properties/primitives";
import {
	asOf,
	capitalize,
	checkOptions,
	contextOf,
	distinct,
	entityUseCase,
	errorOf,
	fields,
	idOf,
	keysOf,
	literal,
	loadSteps,
	metaOf,
	type Options,
	ownerOf,
	type Step,
	valuesOf,
} from "./shared";
import type {
	CreateMaker,
	DeleteMaker,
	GetMaker,
	ListMaker,
	RestoreMaker,
	UpdateMaker,
} from "./types";

/**
 * The declaration of `create` and of `register`, which adds `before` and
 * its errors: an input of the keys of the entity, the entity built from it
 * and stored.
 */
export function createCompilation(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	before: readonly Step[] = [],
	errors: readonly AnyExceptionClass[] = [],
): UseCaseCompilation {
	checkOptions(target, options, ["as", "owner", "omit", "values"]);
	const owner = ownerOf(target, options);
	const omitted = keysOf(target, options, "omit");
	const constants = valuesOf(target, options, "values");
	const notFound = errorOf(target, options, "notFound", UseCaseEntityNotFound);
	const ownerError = errorOf(target, options, "owner", notFound);

	const input: Record<string, BlueprintField> = {};
	const values: Record<string, unknown> = {};
	const dependencies: Record<string, AnyRepository> = {
		repository: target.repository,
	};
	const steps: Step[] = [];
	const used = new Set<AnyExceptionClass>(errors);
	const take = (key: string, field: BlueprintField): void => {
		if (Object.hasOwn(input, key)) {
			target.unavailable(`two keys of the entity take the input "${key}"`);
		}
		input[key] = field;
	};
	/** Loads the entity a key holds, by the id of `reference`, and gives its name. */
	const load = (
		key: string,
		reference: string,
		error: AnyExceptionClass,
	): string => {
		const dependency = `${key}Repository`;
		dependencies[dependency] = target.relation(key, ["findById"]);
		used.add(error);
		steps.push(
			{
				find: `${dependency}.findById`,
				args: [reference],
				as: `${key}Found`,
			},
			{ ensure: "exists", value: `$${key}Found`, error },
		);
		return `$${key}Found`;
	};

	for (const plan of target.fields) {
		const { key } = plan;
		if (plan.identity) continue;
		if (Object.hasOwn(constants, key)) {
			values[key] = literal(constants[key]);
			continue;
		}
		if (owner?.plan.key === key) {
			values[key] =
				plan.kind === "entity"
					? load(key, `$context.${owner.context}`, ownerError)
					: `$context.${owner.context}`;
			continue;
		}
		// An entity that may be absent, and a list of entities, cannot be
		// loaded by steps: they are left out, and given by `values` or later.
		const unloadable =
			plan.kind === "entity-list" || (plan.kind === "entity" && plan.optional);
		if (omitted.includes(plan) || unloadable) {
			if (!plan.optional) {
				target.unavailable(
					unloadable
						? `"${key}" holds a list of entities, which the input cannot take; give it in values`
						: `"${key}" is required and cannot be omitted`,
				);
			}
			continue;
		}
		take(plan.input.key, plan.input.field);
		const given = `$input.${plan.input.key}`;
		if (plan.kind === "entity") {
			values[key] = load(key, given, notFound);
		} else if (plan.convert) {
			steps.push({
				run: `convert${capitalize(key)}`,
				fn: plan.convert,
				args: [given],
				as: `${key}Converted`,
			});
			values[key] = `$${key}Converted`;
		} else {
			values[key] = given;
		}
	}

	return {
		...metaOf(target, options, verb),
		blueprint: fields(() => input),
		response: fields(() => ({ [asOf(target, options)]: target.entity })),
		...contextOf(owner),
		dependencies,
		errors: distinct(...used),
		steps: [
			...before,
			...steps,
			{ build: target.entity, values, as: "built" },
			{ create: "repository", value: "$built", as: "item" },
			{ return: { [asOf(target, options)]: "$item" } },
		],
	};
}

/** Builds an entity from the input and stores it. */
export const create = useCasePluginOf<"create", CreateMaker>("create", {
	description:
		"Builds an entity from the input (its keys, less the identity; an entity it holds by id) and stores it.",
	requires: { actions: ["create"] },
	compile: (target, options) => createCompilation(target, options, "Create"),
});

/** Gives the entity of an id. */
export const get = useCasePluginOf<"get", GetMaker>("get", {
	description: "Gives the entity of an id.",
	requires: { actions: ["findById"] },
	compile: (target, options) =>
		entityUseCase(target, options, "Get", [], () => ({
			steps: [],
			result: "$item",
		})),
});

/** Gives a page of entities. */
export const list = useCasePluginOf<"list", ListMaker>("list", {
	description: "Gives a page of entities: { items, total, limit, offset }.",
	requires: { actions: ["findPage"] },
	compile: (target, options) => {
		checkOptions(target, options, ["owner", "orderBy"]);
		const owner = ownerOf(target, options);
		const { orderBy = [{ key: "createdAt", direction: "desc" }] } = options;
		if (!Array.isArray(orderBy)) {
			target.unavailable("the option orderBy must be a list of orders");
		}
		for (const order of orderBy as readonly { readonly key?: unknown }[]) {
			target.field(String(order?.key));
		}
		return {
			...metaOf(target, options, "List"),
			blueprint: fields(() => ({
				limit: optionalOf(Integer),
				offset: optionalOf(Integer),
			})),
			response: fields(() => ({
				items: listOf(target.entity),
				total: Integer,
				limit: Integer,
				offset: Integer,
			})),
			...contextOf(owner),
			dependencies: { repository: target.repository },
			steps: [
				{
					find: "repository.findPage",
					args: [
						{
							...(owner
								? {
										where: {
											[owner.plan.key]: `$context.${owner.context}`,
										},
									}
								: {}),
							orderBy: literal(orderBy),
							limit: "$input.limit",
							offset: "$input.offset",
						},
					],
					as: "page",
				},
				{
					return: {
						items: "$page.items",
						total: "$page.total",
						limit: "$page.limit",
						offset: "$page.offset",
					},
				},
			],
		};
	},
});

/** Changes the keys the input gives, of those the entity lets change. */
export const update = useCasePluginOf<"update", UpdateMaker>("update", {
	description:
		"Changes the change keys the input gives, leaving the others as they are, and stores the entity.",
	requires: { actions: ["findById", "update"] },
	compile: (target, options) => {
		checkOptions(target, options, ["as", "owner"]);
		const owner = ownerOf(target, options);
		const notFound = errorOf(
			target,
			options,
			"notFound",
			UseCaseEntityNotFound,
		);
		const plans = target.changeKeys
			.map((key) => target.field(key))
			// An entity is changed by a use case that loads it, written by hand.
			.filter((plan) => plan.kind !== "entity" && plan.kind !== "entity-list");
		if (plans.length === 0) {
			target.unavailable("the entity has no change key an input can take");
		}
		if (plans.some((plan) => plan.key === "id")) {
			target.unavailable('"id" cannot be a change key');
		}
		const steps: Step[] = [];
		for (const plan of plans) {
			const given = `$input.${plan.input.key}`;
			let value = given;
			if (plan.convert) {
				steps.push({
					run: `convert${capitalize(plan.key)}`,
					fn: plan.convert,
					args: [given],
					as: `${plan.key}Converted`,
				});
				value = `$${plan.key}Converted`;
			}
			steps.push({ change: "$item", key: plan.key, value, ifPresent: true });
		}
		return {
			...metaOf(target, options, "Update"),
			blueprint: fields(() => ({
				id: idOf(target),
				...Object.fromEntries(
					plans.map((plan) => [plan.input.key, optionalOf(plan.input.field)]),
				),
			})),
			response: fields(() => ({ [asOf(target, options)]: target.entity })),
			...contextOf(owner),
			dependencies: { repository: target.repository },
			errors: [notFound],
			steps: [
				...loadSteps(owner, notFound),
				...steps,
				{ update: "repository", value: "$item", as: "saved" },
				{ return: { [asOf(target, options)]: "$saved" } },
			],
		};
	},
});

/** Deletes the entity of an id, as the repository deletes: for good, or softly. */
const remove = useCasePluginOf<"delete", DeleteMaker>("delete", {
	description:
		"Deletes the entity of an id, hard or soft as the repository declares, and gives it.",
	requires: { actions: ["findById", "delete"] },
	compile: (target, options) =>
		entityUseCase(target, options, "Delete", [], () => ({
			steps: [{ delete: "repository", value: "$item", as: "deleted" }],
			result: "$deleted",
		})),
});

export { remove as delete_ };

/** Brings back a soft-deleted entity. */
export const restore = useCasePluginOf<"restore", RestoreMaker>("restore", {
	description:
		"Brings back the soft-deleted entity of an id; for a repository with soft deletion and the restore action.",
	requires: { actions: ["restore"] },
	compile: (target, options) => {
		// A deleted entity cannot be read to check who owns it before it is back.
		checkOptions(target, options, ["as"]);
		return {
			...metaOf(target, options, "Restore"),
			blueprint: fields(() => ({ id: idOf(target) })),
			response: fields(() => ({ [asOf(target, options)]: target.entity })),
			dependencies: { repository: target.repository },
			steps: [
				{ restore: "repository", value: "$input.id", as: "item" },
				{ return: { [asOf(target, options)]: "$item" } },
			],
		};
	},
});
