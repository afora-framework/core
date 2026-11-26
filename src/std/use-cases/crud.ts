import { listOf } from "../../core/blueprint/list";
import { optionalOf } from "../../core/blueprint/optional";
import type { BlueprintField } from "../../core/blueprint/types/blueprint.interface";
import { generatesIds } from "../../core/entity/abstract-entity";
import { planQuery } from "../../core/repository/plan";
import { inspectRepository } from "../../core/repository/state";
import type { AnyRepository } from "../../core/repository/types/repository.interface";
import { UseCaseEntityNotFound } from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import { isPlain } from "../../core/use-case/steps/references";
import { useCaseTargetOf } from "../../core/use-case/target";
import type {
	UseCaseCompilation,
	UseCaseFieldPlan,
	UseCaseTargetInfo,
} from "../../core/use-case/types/plugin.interface";
import type {
	AnyExceptionClass,
	UseCaseDependency,
} from "../../core/use-case/use-case";
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
	HOOKS,
	hooksOf,
	idOf,
	joinDependencies,
	keysOf,
	literal,
	loadSteps,
	metaOf,
	type Options,
	type Owner,
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
 * The declaration of `create` and of `register`, which adds `checks` and
 * their errors: an input of the keys of the entity, the entity built from
 * it and stored. The option `before` runs first, and the steps after it read
 * the input it gives; `checks` read it under `$input` all the same, rooted
 * by the function given. `taken` gets the keys of the entity the input
 * gives, before the compilation is made.
 */
export function createCompilation(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
	checks: (input: string) => readonly Step[] = () => [],
	errors: readonly AnyExceptionClass[] = [],
	taken?: (keys: readonly string[]) => void,
	extraOptions: readonly string[] = [],
): UseCaseCompilation {
	checkOptions(target, options, [
		...extraOptions,
		"as",
		"owner",
		"omit",
		"values",
		"relations",
		...(verb === "Create" ? ["computed"] : []),
		...HOOKS,
	]);
	const owner = ownerOf(target, options, { self: false });
	const shared = sharedOf(target, options);
	const hooks = hooksOf(target, options);
	const omitted = keysOf(target, options, "omit");
	const computed = keysOf(target, options, "computed");
	const constants = valuesOf(target, options, "values");
	const notFound = errorOf(target, options, "notFound", UseCaseEntityNotFound);
	const ownerError = errorOf(target, options, "owner", notFound);

	if (computed.length > 0) {
		if (options.before === undefined) {
			target.unavailable(
				"the option computed needs a before, which gives the keys back",
			);
		}
		for (const plan of computed) {
			const { key } = plan;
			if (new Set(computed).size !== computed.length) {
				target.unavailable(`computed names "${key}" twice`);
			}
			if (plan.identity) {
				target.unavailable(`computed "${key}" is an identity key`);
			}
			if (plan.kind === "entity" || plan.kind === "entity-list") {
				target.unavailable(
					`computed "${key}" holds an entity, which before cannot give back; it is loaded from an id of the input`,
				);
			}
			if (plan.convert) {
				target.unavailable(
					`computed "${key}" is converted when it is taken from the input, which before's result is not`,
				);
			}
			if (omitted.includes(plan) || Object.hasOwn(constants, key)) {
				target.unavailable(
					`computed "${key}" is also in omit or values, which already say where it comes from`,
				);
			}
			if (owner?.plan.key === key) {
				target.unavailable(`computed "${key}" is the owner key`);
			}
		}
	}

	const input: Record<string, BlueprintField> = {};
	const values: Record<string, unknown> = {};
	const dependencies: Record<string, UseCaseDependency> = {
		repository: target.repository,
	};
	const steps: Step[] = [];
	const inputKeys: string[] = [];
	const used = new Set<AnyExceptionClass>([...errors, ...hooks.throws]);
	const take = (key: string, field: BlueprintField): void => {
		if (Object.hasOwn(input, key)) {
			target.unavailable(`two keys of the entity take the input "${key}"`);
		}
		input[key] = field;
	};
	/**
	 * Loads the entity a key holds, by the id of `reference`, and gives its
	 * name; with `checked`, one that has the owner key must be the caller's.
	 */
	const load = (
		key: string,
		reference: string,
		error: AnyExceptionClass,
		checked = false,
	): string => {
		const dependency = `${key}Repository`;
		const repository = target.relation(key, ["findById"]);
		dependencies[dependency] = repository;
		used.add(error);
		steps.push(
			{
				find: `${dependency}.findById`,
				args: [reference],
				as: `${key}Found`,
			},
			{ ensure: "exists", value: `$${key}Found`, error },
		);
		const held =
			checked && owner && !shared.has(key)
				? ownerReferenceOf(repository, owner)
				: "";
		if (held && owner) {
			steps.push({
				ensure: "equals",
				value: `$${key}Found.${held}`,
				other: `$context.${owner.context}`,
				error,
			});
		}
		return `$${key}Found`;
	};

	for (const plan of target.fields) {
		const { key } = plan;
		// A natural key (an id the entity does not make) comes with the input.
		if (plan.identity && (key !== "id" || generatesIds(target.entity))) {
			continue;
		}
		if (Object.hasOwn(constants, key)) {
			values[key] = literal(constants[key]);
			continue;
		}
		if (computed.includes(plan)) {
			values[key] = `${hooks.input}.${key}`;
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
		inputKeys.push(key);
		const given = `${hooks.input}.${plan.input.key}`;
		if (plan.kind === "entity") {
			values[key] = load(key, given, notFound, true);
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
	taken?.(inputKeys);

	return {
		...metaOf(target, options, verb),
		blueprint: fields(() => input),
		response: fields(() => ({ [asOf(target, options)]: target.entity })),
		...contextOf(owner),
		dependencies: joinDependencies(target, dependencies, hooks),
		errors: distinct(...used),
		steps: [
			...hooks.before(),
			...checks(hooks.input),
			...steps,
			{ build: target.entity, values, as: "built" },
			{ create: "repository", value: "$built", as: "item" },
			...hooks.after("$item"),
			{ return: { [asOf(target, options)]: "$item" } },
		],
	};
}

/**
 * Where an entity of `repository` holds its owner, by the owner key of the
 * use case: the key, or the id of the entity it holds; `""` when it has no
 * such key.
 */
function ownerReferenceOf(repository: AnyRepository, owner: Owner): string {
	const plan = useCaseTargetOf(repository).fields.find(
		(field) => field.key === owner.plan.key,
	);
	if (!plan) return "";
	if (plan.kind === "entity") return `${plan.key}.id`;
	return plan.kind === "property" ? plan.key : "";
}

/**
 * The keys of the option `relations: { <key>: { shared: true } }`: the
 * entities the input loads that need not be the caller's.
 */
function sharedOf(
	target: UseCaseTargetInfo,
	options: Options,
): ReadonlySet<string> {
	const { relations } = options;
	if (relations === undefined) return new Set();
	if (!isPlain(relations)) {
		return target.unavailable(
			"the option relations must be an object of { shared } by key",
		);
	}
	const shared = new Set<string>();
	for (const [key, relation] of Object.entries(relations)) {
		if (target.field(key).kind !== "entity") {
			target.unavailable(
				`relations.${key} must name a key that holds an entity`,
			);
		}
		if (
			!isPlain(relation) ||
			Object.keys(relation).some((option) => option !== "shared") ||
			(relation.shared !== undefined && typeof relation.shared !== "boolean")
		) {
			target.unavailable(`relations.${key} must be { shared?: boolean }`);
		}
		if ((relation as { readonly shared?: boolean }).shared) shared.add(key);
	}
	return shared;
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

/** The largest `limit` of `list`, unless its option `maxLimit` says otherwise. */
const MAX_LIMIT = 100;

/**
 * The declared index that serves the page of `list`: its `where` keys are
 * all matched by equality (the owner key and those of the option `where`),
 * and its `orderBy` is the first order. `undefined` when none does.
 */
function indexOf(
	target: UseCaseTargetInfo,
	owner: Owner | undefined,
	filters: readonly UseCaseFieldPlan[],
	orderBy: unknown,
): string | undefined {
	const indexes = inspectRepository(target.repository)?.indexes;
	if (indexes === undefined || Object.keys(indexes).length === 0) {
		return undefined;
	}
	const where: Record<string, unknown> = {};
	for (const key of [owner?.plan.key, ...filters.map((plan) => plan.key)]) {
		if (key !== undefined) where[key] = true;
	}
	if (Object.keys(where).length === 0) return undefined;
	const first = (orderBy as readonly { readonly key: string }[])[0]?.key;
	const plan = planQuery(
		{ unique: [], indexes },
		{ where, ...(first === undefined ? {} : { orderBy: [{ key: first }] }) },
	);
	return plan.access === "index" ? plan.index : undefined;
}

/** Gives a page of entities. */
export const list = useCasePluginOf<"list", ListMaker>("list", {
	description: "Gives a page of entities: { items, total, limit, offset }.",
	requires: { actions: ["findPage"] },
	compile: (target, options) => {
		checkOptions(target, options, ["owner", "where", "orderBy", "maxLimit"]);
		const owner = ownerOf(target, options);
		const filters = keysOf(target, options, "where");
		const filtered = new Set<string>();
		for (const plan of filters) {
			if (filtered.has(plan.key)) {
				target.unavailable(`where names "${plan.key}" twice`);
			}
			filtered.add(plan.key);
			if (plan.kind !== "property" || plan.sensitive) {
				target.unavailable(
					`where "${plan.key}" must be a key that holds a scalar value, which the input can match by equality`,
				);
			}
			if (owner?.plan.key === plan.key) {
				target.unavailable(
					`where "${plan.key}" is the owner key, which owner already matches`,
				);
			}
			if (plan.key === "limit" || plan.key === "offset") {
				target.unavailable(
					`where "${plan.key}" would take the input of the page`,
				);
			}
		}
		const {
			orderBy = [{ key: "createdAt", direction: "desc" }],
			maxLimit = MAX_LIMIT,
		} = options;
		if (!Number.isInteger(maxLimit) || (maxLimit as number) < 1) {
			target.unavailable("the option maxLimit must be a whole number above 0");
		}
		const Limit = Integer.with({ max: maxLimit as number });
		if (!Array.isArray(orderBy)) {
			target.unavailable("the option orderBy must be a list of orders");
		}
		for (const order of orderBy as readonly { readonly key?: unknown }[]) {
			target.field(String(order?.key));
		}
		const index = indexOf(target, owner, filters, orderBy);
		return {
			...metaOf(target, options, "List"),
			...(index === undefined ? {} : { index }),
			blueprint: fields(() => ({
				...Object.fromEntries(
					filters.map((plan) => [plan.input.key, plan.input.field]),
				),
				limit: optionalOf(Limit),
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
							...(owner || filters.length > 0
								? {
										where: {
											...(owner
												? { [owner.plan.key]: `$context.${owner.context}` }
												: {}),
											...Object.fromEntries(
												filters.map((plan) => [
													plan.key,
													`$input.${plan.input.key}`,
												]),
											),
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
		checkOptions(target, options, ["as", "owner", ...HOOKS]);
		const owner = ownerOf(target, options);
		const hooks = hooksOf(target, options);
		const notFound = errorOf(
			target,
			options,
			"notFound",
			UseCaseEntityNotFound,
		);
		const changeable = target.changeKeys
			.map((key) => target.field(key))
			// An entity is changed by a use case that loads it, written by hand.
			.filter((plan) => plan.kind !== "entity" && plan.kind !== "entity-list");
		// A sensitive key (a password) is changed only with a proof, such as
		// the current password of `changePassword`, never from a plain input.
		const plans = changeable.filter((plan) => !plan.sensitive);
		if (plans.length === 0) {
			const sensitive = changeable.map((plan) => `"${plan.key}"`).join(", ");
			target.unavailable(
				changeable.length > 0
					? `the entity has no change key an input can take: ${sensitive} is sensitive, and the standard use cases never take a sensitive key as input (a password is changed by changePassword)`
					: "the entity has no change key an input can take",
			);
		}
		if (plans.some((plan) => plan.key === "id")) {
			target.unavailable('"id" cannot be a change key');
		}
		if (owner && plans.some((plan) => plan.key === owner.plan.key)) {
			target.unavailable(
				`"${owner.plan.key}" holds the owner, so with owner it cannot be a change key: the caller could give the entity away`,
			);
		}
		const steps: Step[] = [];
		for (const plan of plans) {
			const given = `${hooks.input}.${plan.input.key}`;
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
			dependencies: joinDependencies(
				target,
				{ repository: target.repository },
				hooks,
			),
			errors: distinct(notFound, ...hooks.throws),
			steps: [
				...loadSteps(owner, notFound),
				...hooks.before("$item"),
				...steps,
				{ update: "repository", value: "$item", as: "saved" },
				...hooks.after("$saved"),
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
		entityUseCase(
			target,
			options,
			"Delete",
			[],
			() => ({
				steps: [{ delete: "repository", value: "$item", as: "deleted" }],
				result: "$deleted",
			}),
			true,
		),
});

export { remove as delete_ };

/** Brings back a soft-deleted entity. */
export const restore = useCasePluginOf<"restore", RestoreMaker>("restore", {
	description:
		"Brings back the soft-deleted entity of an id; for a repository with soft deletion and the restore action.",
	requires: { actions: ["restore"] },
	compile: (target, options) => {
		checkOptions(target, options, ["as", "owner", ...HOOKS]);
		const owner = ownerOf(target, options);
		const hooks = hooksOf(target, options);
		const notFound = errorOf(
			target,
			options,
			"notFound",
			UseCaseEntityNotFound,
		);
		const id = `${hooks.input}.id`;
		const checks: Step[] = [];
		if (owner?.plan.key === "id") {
			checks.push({
				ensure: "equals",
				value: id,
				other: `$context.${owner.context}`,
				error: notFound,
			});
		} else if (owner) {
			// findById does not see a deleted entity: `exists` reads it with the
			// deleted ones, by its id and its owner.
			if (!target.actions.includes("exists")) {
				target.unavailable(
					'with owner, it needs the action "exists", to read the deleted entity and its owner',
				);
			}
			checks.push(
				{
					find: "repository.exists",
					args: [
						{
							where: {
								id,
								[owner.plan.key]: `$context.${owner.context}`,
							},
							withDeleted: true,
						},
					],
					as: "owned",
				},
				{ ensure: "true", value: "$owned", error: notFound },
			);
		}
		return {
			...metaOf(target, options, "Restore"),
			blueprint: fields(() => ({ id: idOf(target) })),
			response: fields(() => ({ [asOf(target, options)]: target.entity })),
			...contextOf(owner),
			dependencies: joinDependencies(
				target,
				{ repository: target.repository },
				hooks,
			),
			errors: distinct(...(owner ? [notFound] : []), ...hooks.throws),
			steps: [
				...hooks.before(),
				...checks,
				{ restore: "repository", value: id, as: "item" },
				...hooks.after("$item"),
				{ return: { [asOf(target, options)]: "$item" } },
			],
		};
	},
});
