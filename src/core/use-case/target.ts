import { fieldOf } from "../blueprint/callable";
import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { recordFieldOf } from "../blueprint/record-field";
import type { BlueprintField } from "../blueprint/types/blueprint.interface";
import { ENTITY_IDENTITY_KEYS } from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import { isProperty } from "../property/is-property";
import { recordNameOf } from "../record/name";
import { pluginsOf } from "../record/plugin";
import { findState, relatedRepositoryOf } from "../repository/state";
import type {
	AnyRepository,
	AnyRepositoryEntity,
} from "../repository/types/repository.interface";
import { UseCaseUnavailable } from "./exceptions";
import type {
	UseCaseFieldPlan,
	UseCaseTargetInfo,
} from "./types/plugin.interface";

const IDENTITY: readonly string[] = ENTITY_IDENTITY_KEYS;

/** Whether a field accepts `undefined`. */
function isOptionalField(field: BlueprintField): boolean {
	if (isProperty(field)) return field.type.optional === true;
	const record = recordFieldOf(field);
	if (record) return record.optional;
	return (field as { readonly optional?: boolean }).optional === true;
}

/** The plan of one key of `entity`. */
function planOf(
	entity: AnyRepositoryEntity,
	key: string,
	owners: ReadonlyMap<string, string>,
): UseCaseFieldPlan {
	const field = fieldOf(
		entity.blueprint.properties[key] as BlueprintField,
	) as BlueprintField;
	const optional = isOptionalField(field);
	const record = recordFieldOf(field);
	const item = isBlueprintList(field)
		? recordFieldOf((field as { readonly item: unknown }).item)
		: undefined;
	const related = [record?.record, item?.record].find(isEntityClass) as
		| AnyRepositoryEntity
		| undefined;
	const kind: UseCaseFieldPlan["kind"] = record
		? related
			? "entity"
			: "record"
		: isBlueprintList(field)
			? related
				? "entity-list"
				: "list"
			: isBlueprint(field)
				? "blueprint"
				: "property";
	let input: UseCaseFieldPlan["input"] = { key, field };
	if (kind === "entity" && related) {
		const id = related.blueprint.properties.id as BlueprintField;
		input = { key: `${key}Id`, field: optional ? optionalOf(id) : id };
	}
	return Object.freeze({
		key,
		field,
		identity: IDENTITY.includes(key),
		plugin: owners.get(key),
		sensitive: entity.options.sensitive.includes(key),
		unique: entity.options.unique.includes(key),
		optional,
		change: entity.options.change.includes(key),
		kind,
		related,
		input: Object.freeze(input),
	});
}

/**
 * What a use case plugin reads of `repository`: its entity, its actions and
 * a plan of every key, to derive blueprints and steps from. `source` names
 * who asks, in the `UseCaseUnavailable` it throws. Throws a `TypeError` when
 * `repository` was not made by `repositoryOf`.
 */
export function useCaseTargetOf(
	repository: AnyRepository,
	source = "useCaseTargetOf",
): UseCaseTargetInfo {
	const state = findState(repository);
	if (!state) throw new TypeError("Expected a repository made by repositoryOf");
	const { entity } = state;
	const unavailable = (reason: string): never => {
		throw new UseCaseUnavailable({
			source,
			details: { repository: state.name, reason },
		});
	};
	const owners = new Map<string, string>();
	for (const plugin of pluginsOf(entity)) {
		for (const key of plugin.keys) owners.set(key, plugin.name);
	}
	const fields = Object.freeze(
		Object.keys(entity.blueprint.properties).map((key) =>
			planOf(entity, key, owners),
		),
	);
	const field = (key: string): UseCaseFieldPlan =>
		fields.find((plan) => plan.key === key) ??
		unavailable(`the entity has no key "${key}"`);
	return Object.freeze({
		repository,
		repositoryName: state.name,
		entity,
		entityName: recordNameOf(entity),
		actions: state.actions,
		deletion: state.deletion,
		fields,
		changeKeys: entity.options.change as readonly string[],
		uniqueKeys: entity.options.unique as readonly string[],
		field,
		relation(key: string, actions: readonly string[] = []): AnyRepository {
			const { related } = field(key);
			const found = related
				? (relatedRepositoryOf(repository, related) as
						| AnyRepository
						| undefined)
				: undefined;
			if (!found) {
				return unavailable(
					`the repository has no relation for the entity of "${key}"`,
				);
			}
			const missing = actions.filter(
				(action) => !(found.actions as readonly string[]).includes(action),
			);
			if (missing.length > 0) {
				unavailable(
					`the repository of "${key}" lacks the action ${missing
						.map((action) => `"${action}"`)
						.join(", ")}`,
				);
			}
			return found;
		},
		unavailable,
	});
}
