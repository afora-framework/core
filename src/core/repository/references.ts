import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isEntityClass } from "../entity/entity";
import { type ExecutionScope, scopedProvider } from "../use-case/scope";
import {
	InvalidRepositoryData,
	InvalidRepositoryDeclaration,
	RepositoryEntityNotFound,
} from "./exceptions";
import { contextOf, findState, type RepositoryState } from "./state";
import type {
	AnyRepositoryEntity,
	RepositoryData,
} from "./types/repository.interface";

type Plain = Readonly<Record<string, unknown>>;

function isPlain(value: unknown): value is Plain {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record class `field` holds, with the blueprint of its properties. */
function recordClassOf(field: BlueprintField | undefined) {
	return recordFieldOf(field)?.record as
		| (AnyRepositoryEntity & {
				readonly blueprint: { readonly properties: IBlueprintCollection };
		  })
		| undefined;
}

/**
 * The entity classes `properties` hold, at any depth: through blueprints,
 * lists, optional records and records that are not entities, stopping at each
 * entity, whose own entities are the concern of its repository.
 */
function entityClassesOf(
	properties: IBlueprintCollection,
): ReadonlySet<AnyRepositoryEntity> {
	const found = new Set<AnyRepositoryEntity>();
	function visit(field: BlueprintField | undefined): void {
		if (isBlueprintList(field)) {
			visit(field.item);
		} else if (isBlueprint(field)) {
			walk(field.properties);
		} else {
			const record = recordClassOf(field);
			if (!record) return;
			if (isEntityClass(record as unknown)) found.add(record);
			else walk(record.blueprint.properties);
		}
	}
	function walk(properties: IBlueprintCollection): void {
		for (const field of Object.values(properties)) visit(field);
	}
	walk(properties);
	return found;
}

/**
 * `data`, the plain value of a record of `properties`, with the value of each
 * entity field (its stored id) replaced by what `visit` gives for the entity
 * class and that value. Records that are not entities are walked into.
 */
function mapReferences(
	properties: IBlueprintCollection,
	data: RepositoryData,
	visit: (entity: AnyRepositoryEntity, value: unknown) => unknown,
): RepositoryData {
	function mapField(
		field: BlueprintField | undefined,
		value: unknown,
	): unknown {
		if (value === undefined || value === null) return value;
		if (isBlueprintList(field)) {
			return Array.isArray(value)
				? Object.freeze(value.map((item) => mapField(field.item, item)))
				: value;
		}
		if (isBlueprint(field)) {
			return isPlain(value) ? mapCollection(field.properties, value) : value;
		}
		const record = recordClassOf(field);
		if (!record) return value;
		if (isEntityClass(record as unknown)) return visit(record, value);
		return isPlain(value)
			? mapCollection(record.blueprint.properties, value)
			: value;
	}
	function mapCollection(
		properties: IBlueprintCollection,
		value: Plain,
	): Plain {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					mapField(properties[key], item),
				]),
			),
		);
	}
	return mapCollection(properties, data);
}

/** The relations of a repository of `entity` named `name`, one for each entity class it holds. */
export function relationsOf(
	name: string,
	entity: AnyRepositoryEntity,
	relations: unknown,
): ReadonlyMap<object, RepositoryState> {
	const invalid = (reason: string): never => {
		throw new InvalidRepositoryDeclaration({
			source: name,
			details: { reason },
		});
	};
	if (relations === undefined) relations = [];
	if (!Array.isArray(relations)) {
		return invalid("Expected relations to be a list of repositories.");
	}

	const related: RepositoryState[] = [];
	for (const relation of relations) {
		const state = findState(relation);
		if (!state) return invalid("Expected relations made by repositoryOf.");
		if (related.some((other) => other.entity === state.entity)) {
			return invalid(`Relation "${state.entity.name}" is duplicated.`);
		}
		if (typeof state.provider.findMany !== "function") {
			return invalid(
				`The provider of "${state.name}" has no "findMany" to load it.`,
			);
		}
		related.push(state);
	}

	const used = new Set<RepositoryState>();
	const map = new Map<object, RepositoryState>();
	for (const target of entityClassesOf(entity.blueprint.properties)) {
		const matches = related.filter(
			(state) =>
				state.entity === target || state.entity.prototype instanceof target,
		);
		const exact = matches.find((state) => state.entity === target);
		if (!exact && matches.length === 0) {
			return invalid(`Missing relation: no repository of "${target.name}".`);
		}
		if (!exact && matches.length > 1) {
			return invalid(
				`Relation "${target.name}" matches more than one repository.`,
			);
		}
		const state = (exact ?? matches[0]) as RepositoryState;
		map.set(target, state);
		used.add(state);
	}
	for (const state of related) {
		if (!used.has(state)) {
			return invalid(
				`Relation "${state.entity.name}" is not held by ${entity.name}.`,
			);
		}
	}
	return map;
}

/** The entity of a stored value, whose own references are already instances. */
export function parseEntity(state: RepositoryState, data: RepositoryData) {
	const parsed = state.entity.safeParse(data);
	if (parsed.issues) {
		throw new InvalidRepositoryData({
			source: state.name,
			cause: parsed.issues.find((issue) => issue.cause)?.cause,
		});
	}
	return parsed.value as object;
}

/** What one read shares: the entities it loaded, by repository and id. */
export type ReferenceSession = Map<RepositoryState, Map<string, object>>;

/** The stored values of `ids`, in one `findMany`, under the policy of their repository. */
function loadByIds(
	state: RepositoryState,
	ids: readonly string[],
	scope: ExecutionScope | undefined,
): Promise<readonly RepositoryData[]> {
	return scopedProvider(scope, state.provider).findMany(contextOf(state), {
		where: { id: { in: ids } },
		withDeleted: state.deletion === "hard",
	});
}

/**
 * `datas`, the stored values of the entities of `state`, with the id of each
 * entity they hold replaced by the entity, loaded in one batch for each
 * relation. An entity loaded twice in `session` is the same instance. Throws
 * `InvalidRepositoryData`, caused by `RepositoryEntityNotFound`, for an id
 * with no entity. The providers of the `scope` of the call, if any, replace
 * those of the relations.
 */
export async function resolveReferences(
	state: RepositoryState,
	datas: readonly RepositoryData[],
	session: ReferenceSession,
	scope?: ExecutionScope,
): Promise<readonly RepositoryData[]> {
	if (state.relations.size === 0) return datas;
	const { properties } = state.entity.blueprint;

	const wanted = new Map<RepositoryState, Set<string>>();
	for (const data of datas) {
		mapReferences(properties, data, (target, value) => {
			const relation = state.relations.get(target);
			if (relation && typeof value === "string") {
				const ids = wanted.get(relation) ?? new Set<string>();
				wanted.set(relation, ids.add(value));
			}
			return value;
		});
	}

	for (const [relation, ids] of wanted) {
		const loaded = session.get(relation) ?? new Map<string, object>();
		session.set(relation, loaded);
		const missing = [...ids].filter((id) => !loaded.has(id));
		if (missing.length === 0) continue;

		const found = await loadByIds(relation, missing, scope);
		const resolved = await resolveReferences(relation, found, session, scope);
		for (const data of resolved) {
			const id = data.id as string;
			if (!loaded.has(id)) loaded.set(id, parseEntity(relation, data));
		}
		for (const id of missing) {
			if (loaded.has(id)) continue;
			throw new InvalidRepositoryData({
				source: state.name,
				cause: new RepositoryEntityNotFound({
					source: relation.name,
					details: { id },
				}),
			});
		}
	}

	return datas.map((data) =>
		mapReferences(properties, data, (target, value) => {
			const relation = state.relations.get(target);
			return relation && typeof value === "string"
				? (session.get(relation)?.get(value) ?? value)
				: value;
		}),
	);
}
