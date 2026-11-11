import {
	Exception,
	type ILogger,
	InvalidRepositoryDeclaration,
	InvalidRepositoryQuery,
	RepositoryConcurrencyConflict,
	RepositoryEntityNotFound,
	RepositoryUniqueViolation,
} from "@afora/core";
import type {
	IRepositoryProvider,
	ProviderQuery,
	RepositoryContext,
	RepositoryData,
} from "@afora/core/adapters";
import { matchesQuery, selectRows } from "@afora/core/experimental";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	BatchGetCommand,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
	type TransactWriteCommandInput,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type BatchGetPage, batchGetAll, type ItemKey } from "./batch";
import {
	byteLength,
	entityPk,
	isPresent,
	MAX_SORT_KEY_BYTES,
	markerOf,
	markersOf,
	storable,
	uniquePk,
} from "./encoding";
import { backoffOf, writeFailureOf } from "./errors";
import { DynamoDbLimitExceeded, DynamoDbRetriesExhausted } from "./exceptions";

export interface DynamoDbProviderOptions {
	/** The name of the table: string keys `pk` (partition) and `sk` (sort). */
	readonly table: string;
	/** A `DynamoDBClient`, or a `DynamoDBDocumentClient` made from one. */
	readonly client: DynamoDBClient | DynamoDBDocumentClient;
	/**
	 * Where retries (`debug`, `dynamodb.retry`) and errors that are not
	 * afora's own (`warn`, `dynamodb.error`) are told; an application's
	 * `ILogger` fits. Nothing is logged without it.
	 */
	readonly logger?: Pick<ILogger, "debug" | "warn">;
	/**
	 * How often a request DynamoDB refuses for now is sent again: keys left
	 * unprocessed by `BatchGetItem`, transactions cancelled by a conflicting
	 * one, writes that lost a race. Defaults to 10 attempts, from 25 ms.
	 */
	readonly retry?: {
		readonly attempts?: number;
		readonly baseDelayMs?: number;
	};
}

/**
 * The provider of `dynamoDbProvider`: it reads by cursor, honors expected
 * versions, increments atomically and leaves expired records out. It has no
 * transactions: DynamoDB only writes up to 100 items at once, without reads
 * in between.
 */
export type DynamoDbProvider = IRepositoryProvider & {
	readonly capabilities: {
		readonly keyset: true;
		readonly versioning: true;
		readonly atomic: true;
		readonly expiry: true;
	};
	/** A no-op: DynamoDB has no schema to change. See the README. */
	migrate(): Promise<void>;
};

type TransactItem = NonNullable<
	TransactWriteCommandInput["TransactItems"]
>[number];

/** A condition of a write, with its names and values. */
interface Condition {
	readonly ConditionExpression: string;
	readonly ExpressionAttributeNames?: Record<string, string>;
	readonly ExpressionAttributeValues?: Record<string, unknown>;
}

/** An entity as an item: its value in `data`, its markers in `m`. */
interface EntityItem {
	readonly pk: string;
	readonly sk: string;
	readonly data: Record<string, unknown>;
	/** `markersOf(data)`, which writes condition on. */
	readonly m?: string;
}

/** The most items of one `TransactWriteItems`. */
const TRANSACTION_LIMIT = 100;

const SOURCE = "dynamodb";

function invalid(reason: string): never {
	throw new InvalidRepositoryDeclaration({
		source: SOURCE,
		details: { reason },
	});
}

function isMembership(
	condition: unknown,
): condition is { readonly in: readonly unknown[] } {
	return (
		typeof condition === "object" &&
		condition !== null &&
		!Array.isArray(condition) &&
		Object.keys(condition).length === 1 &&
		Array.isArray((condition as { in?: unknown }).in)
	);
}

/** The key holding the expiry of the entities of `context`, on any version of `@afora/core`. */
const expiryKeyOf = (context: RepositoryContext): string | undefined =>
	(context as { readonly expiry?: { readonly key: string } }).expiry?.key;

/** The unique keys enforced with markers: every one but `id`, the sort key. */
const markedKeys = (context: RepositoryContext): readonly string[] =>
	context.unique.filter((key) => key !== "id");

const NEW_ITEM: Condition = { ConditionExpression: "attribute_not_exists(pk)" };

/**
 * The item still holds the markers `m` (no write moved them since it was
 * read) and, for each of `equal`, the value given.
 */
function unchanged(
	m: string | undefined,
	equal: readonly (readonly [string, unknown])[] = [],
): Condition {
	const names: Record<string, string> = { "#m": "m" };
	const values: Record<string, unknown> = {};
	const parts = [
		"attribute_exists(pk)",
		m === undefined ? "attribute_not_exists(#m)" : "#m = :m",
	];
	if (m !== undefined) values[":m"] = m;
	equal.forEach(([key, value], index) => {
		names["#data"] = "data";
		names[`#e${index}`] = key;
		values[`:e${index}`] = value;
		parts.push(`#data.#e${index} = :e${index}`);
	});
	return {
		ConditionExpression: parts.join(" AND "),
		ExpressionAttributeNames: names,
		...(Object.keys(values).length > 0
			? { ExpressionAttributeValues: values }
			: {}),
	};
}

function documentClientOf(
	client: DynamoDbProviderOptions["client"],
): DynamoDBDocumentClient {
	if (client instanceof DynamoDBDocumentClient) return client;
	return DynamoDBDocumentClient.from(client as DynamoDBClient, {
		marshallOptions: { removeUndefinedValues: true },
	});
}

/**
 * A repository provider on one DynamoDB table shared by every entity:
 *
 * - entity: `pk = E#<context.name>`,       `sk = <id>`,             `data`, `m`
 * - marker: `pk = U#<context.name>#<key>`, `sk = <encoded value>`,  `id`
 *
 * Unique keys other than `id` are enforced with marker items written in the
 * same transaction as the entity. Reads get their candidates by `id`, through
 * the marker of a unique key, or by querying the partition of the repository,
 * then filter, order and page them as `inMemoryProvider` does. See the
 * package README for the layout and its limits.
 */
export function dynamoDbProvider(
	options: DynamoDbProviderOptions,
): DynamoDbProvider {
	if (
		!options ||
		typeof options !== "object" ||
		typeof options.table !== "string" ||
		options.table.length === 0 ||
		typeof options.client !== "object" ||
		options.client === null ||
		typeof (options.client as { send?: unknown }).send !== "function"
	)
		invalid(
			"Expected { table, client } with a table name and a DynamoDBClient.",
		);
	const { table: TableName, logger } = options;
	const attempts = Math.max(1, options.retry?.attempts ?? 10);
	const baseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 25);
	const db = documentClientOf(options.client);
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	const exhausted = (context: RepositoryContext, operation: string): never => {
		throw new DynamoDbRetriesExhausted({
			source: context.name,
			details: { operation, attempts },
		});
	};

	const notFound = (context: RepositoryContext, id: string) =>
		new RepositoryEntityNotFound({ source: context.name, details: { id } });

	const uniqueViolation = (context: RepositoryContext, key: string) =>
		new RepositoryUniqueViolation({ source: context.name, details: { key } });

	const sortKey = (context: RepositoryContext, sk: string): string => {
		if (byteLength(sk) > MAX_SORT_KEY_BYTES) {
			throw new DynamoDbLimitExceeded({
				source: context.name,
				details: {
					reason: `A key of "${context.name}" takes more than ${MAX_SORT_KEY_BYTES} bytes, the most a DynamoDB sort key holds.`,
				},
			});
		}
		return sk;
	};

	const idOf = (context: RepositoryContext, data: RepositoryData): string => {
		if (typeof data.id !== "string" || data.id.length === 0)
			invalid(`An entity of "${context.name}" has no string id.`);
		return sortKey(context, data.id);
	};

	const entityKey = (context: RepositoryContext, id: string): ItemKey => ({
		pk: entityPk(context.name),
		sk: id,
	});

	const markerKey = (
		context: RepositoryContext,
		key: string,
		value: unknown,
	): ItemKey => ({
		pk: uniquePk(context.name, key),
		sk: sortKey(context, markerOf(value)),
	});

	// ── reads ───────────────────────────────────────────────────────────────

	async function getItem(
		context: RepositoryContext,
		id: string,
	): Promise<EntityItem | undefined> {
		const { Item } = await db.send(
			new GetCommand({
				TableName,
				Key: entityKey(context, id),
				ConsistentRead: true,
			}),
		);
		return Item as EntityItem | undefined;
	}

	const batchGet = (context: RepositoryContext, keys: readonly ItemKey[]) =>
		batchGetAll(keys, {
			table: TableName,
			attempts,
			baseDelayMs,
			send: (Keys) =>
				db.send(
					new BatchGetCommand({
						RequestItems: {
							[TableName]: { Keys: [...Keys], ConsistentRead: true },
						},
					}),
				) as Promise<BatchGetPage>,
			onRetry: (attempt, left) =>
				logger?.debug("dynamodb.retry", {
					operation: "BatchGetItem",
					repository: context.name,
					attempt,
					left,
				}),
			onExhausted: () => exhausted(context, "BatchGetItem"),
		});

	/** The entities of `ids`, in the order of their sort keys, as a query gives them. */
	async function getMany(
		context: RepositoryContext,
		ids: readonly unknown[],
	): Promise<RepositoryData[]> {
		const unique = [
			...new Set(
				ids.filter(
					(id): id is string =>
						typeof id === "string" &&
						id.length > 0 &&
						byteLength(id) <= MAX_SORT_KEY_BYTES,
				),
			),
		];
		const items = (await batchGet(
			context,
			unique.map((id) => entityKey(context, id)),
		)) as unknown as EntityItem[];
		return items
			.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
			.map((item) => item.data);
	}

	/** The ids the markers of `key` point to, for each value. */
	async function markedIds(
		context: RepositoryContext,
		key: string,
		values: readonly unknown[],
	): Promise<unknown[]> {
		const keys = new Map<string, ItemKey>();
		for (const value of values) {
			const sk = markerOf(value);
			if (byteLength(sk) <= MAX_SORT_KEY_BYTES)
				keys.set(sk, { pk: uniquePk(context.name, key), sk });
		}
		const markers = await batchGet(context, [...keys.values()]);
		return markers.map((marker) => marker.id);
	}

	async function partition(
		context: RepositoryContext,
	): Promise<RepositoryData[]> {
		const rows: RepositoryData[] = [];
		let ExclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await db.send(
				new QueryCommand({
					TableName,
					KeyConditionExpression: "pk = :pk",
					ExpressionAttributeValues: { ":pk": entityPk(context.name) },
					ConsistentRead: true,
					ExclusiveStartKey,
				}),
			);
			for (const item of page.Items ?? []) rows.push((item as EntityItem).data);
			ExclusiveStartKey = page.LastEvaluatedKey;
		} while (ExclusiveStartKey);
		return rows;
	}

	/** Whether `query` reads the partition in the order of its sort key, `id` ascending. */
	function inIdOrder(query: ProviderQuery): boolean {
		const orders = query.orderBy ?? [];
		if (orders.length === 0) return query.after === undefined;
		const [order] = orders;
		return (
			orders.length === 1 &&
			order?.key === "id" &&
			(order.direction ?? "asc") === "asc"
		);
	}

	/**
	 * The rows of a page of the partition read in the order of the sort key,
	 * as the walk of `app.migrate` and cursors by id read them: a `Query` from
	 * the `after` id (`sk > after`) with `Limit`, filtered in memory
	 * (`withDeleted`, `withExpired`, `where`) and continued until `limit` rows
	 * match or the partition ends, so a walk reads each item once instead of
	 * the whole partition per page. `undefined` when `query` needs the whole
	 * partition: another order, an `offset`, no `limit`, or a `where` on `id`
	 * or a unique key (read by key instead).
	 */
	async function pageInIdOrder(
		context: RepositoryContext,
		query: ProviderQuery,
	): Promise<RepositoryData[] | undefined> {
		const { limit, after } = query;
		if (limit === undefined || (query.offset ?? 0) !== 0) return undefined;
		if (!inIdOrder(query)) return undefined;
		const where = query.where ?? {};
		if (where.id !== undefined) return undefined;
		if (markedKeys(context).some((key) => where[key] !== undefined))
			return undefined;
		const from = after?.[0];
		if (
			after !== undefined &&
			(typeof from !== "string" || byteLength(from) > MAX_SORT_KEY_BYTES)
		)
			return undefined;
		const rows: RepositoryData[] = [];
		if (limit <= 0) return rows;
		const expiry = expiryKeyOf(context);
		let ExclusiveStartKey: Record<string, unknown> | undefined;
		do {
			const page = await db.send(
				new QueryCommand({
					TableName,
					KeyConditionExpression:
						from === undefined ? "pk = :pk" : "pk = :pk AND sk > :after",
					ExpressionAttributeValues: {
						":pk": entityPk(context.name),
						...(from === undefined ? {} : { ":after": from }),
					},
					ConsistentRead: true,
					Limit: limit - rows.length,
					ExclusiveStartKey,
				}),
			);
			for (const item of page.Items ?? []) {
				const { data } = item as EntityItem;
				if (matchesQuery(data, query, expiry)) rows.push(data);
			}
			ExclusiveStartKey = page.LastEvaluatedKey;
		} while (ExclusiveStartKey && rows.length < limit);
		return rows;
	}

	/**
	 * Rows that may match `query`, read the cheapest way: by id, through the
	 * markers of a unique key, or the whole partition. The caller filters them.
	 */
	async function candidates(
		context: RepositoryContext,
		query: ProviderQuery,
	): Promise<RepositoryData[]> {
		const where = query.where ?? {};
		const valuesOf = (condition: unknown): readonly unknown[] =>
			isMembership(condition) ? condition.in : [condition];
		if (where.id !== undefined) return getMany(context, valuesOf(where.id));
		for (const key of markedKeys(context)) {
			if (where[key] === undefined) continue;
			const values = valuesOf(where[key]);
			// A missing value has no marker: only a scan finds it.
			if (!values.every(isPresent)) continue;
			return getMany(context, await markedIds(context, key, values));
		}
		return partition(context);
	}

	// ── writes ──────────────────────────────────────────────────────────────

	/** Sends one item as its own request, which a transaction of one would only slow down. */
	async function sendOne(item: TransactItem): Promise<void> {
		if (item.Put) await db.send(new PutCommand(item.Put));
		else if (item.Delete) await db.send(new DeleteCommand(item.Delete));
		else if (item.Update) await db.send(new UpdateCommand(item.Update));
		else invalid("Unexpected write.");
	}

	/**
	 * Writes `items` at once, retrying while other transactions conflict. Gives
	 * the index of the item whose condition failed, or `undefined` once written.
	 */
	async function write(
		context: RepositoryContext,
		items: readonly TransactItem[],
	): Promise<number | undefined> {
		if (items.length > TRANSACTION_LIMIT) {
			throw new DynamoDbLimitExceeded({
				source: context.name,
				details: {
					reason: `A write of "${context.name}" needs ${items.length} items (the entity and the markers of its unique keys), more than the ${TRANSACTION_LIMIT} of a DynamoDB transaction.`,
				},
			});
		}
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				if (items.length === 1) await sendOne(items[0] as TransactItem);
				else
					await db.send(
						new TransactWriteCommand({ TransactItems: [...items] }),
					);
				return undefined;
			} catch (error) {
				const failure = writeFailureOf(error);
				if (failure === undefined) throw error;
				if (failure.kind === "condition") return failure.index;
				logger?.debug("dynamodb.retry", {
					operation: "TransactWriteItems",
					repository: context.name,
					attempt,
				});
				await sleep(backoffOf(attempt, baseDelayMs));
			}
		}
		return exhausted(context, "TransactWriteItems");
	}

	const putEntity = (
		context: RepositoryContext,
		data: Record<string, unknown>,
		condition: Condition,
	): TransactItem => ({
		Put: {
			TableName,
			Item: {
				...entityKey(context, idOf(context, data)),
				data,
				m: markersOf(data, markedKeys(context)),
			},
			...condition,
		},
	});

	const putMarker = (
		context: RepositoryContext,
		key: string,
		value: unknown,
		id: string,
	): TransactItem => ({
		Put: {
			TableName,
			Item: { ...markerKey(context, key, value), id },
			ConditionExpression: "attribute_not_exists(pk)",
		},
	});

	const deleteMarker = (
		context: RepositoryContext,
		key: string,
		value: unknown,
	): TransactItem => ({
		Delete: { TableName, Key: markerKey(context, key, value) },
	});

	/**
	 * Inserts `data` with its markers. Gives `false` when an item already holds
	 * its id, and throws `RepositoryUniqueViolation` for another unique key.
	 */
	async function create(
		context: RepositoryContext,
		data: Record<string, unknown>,
	): Promise<boolean> {
		const id = idOf(context, data);
		const keys = markedKeys(context).filter((key) => isPresent(data[key]));
		const failed = await write(context, [
			putEntity(context, data, NEW_ITEM),
			...keys.map((key) => putMarker(context, key, data[key], id)),
		]);
		if (failed === undefined) return true;
		if (failed === 0) return false;
		throw uniqueViolation(context, keys[failed - 1] as string);
	}

	/**
	 * Replaces `previous` by `data`, moving the markers of the unique values
	 * that changed. Gives `false` when the item changed since it was read (or
	 * a value of `equal` differs), and throws `RepositoryUniqueViolation` when
	 * another entity holds a new unique value.
	 */
	async function replace(
		context: RepositoryContext,
		previous: EntityItem,
		data: Record<string, unknown>,
		equal?: readonly (readonly [string, unknown])[],
	): Promise<boolean> {
		const id = idOf(context, data);
		const before = previous.data;
		const changed = markedKeys(context).filter(
			(key) =>
				isPresent(before[key]) !== isPresent(data[key]) ||
				(isPresent(data[key]) && markerOf(before[key]) !== markerOf(data[key])),
		);
		const removed = changed.filter((key) => isPresent(before[key]));
		const added = changed.filter((key) => isPresent(data[key]));
		const failed = await write(context, [
			putEntity(context, data, unchanged(previous.m, equal)),
			...removed.map((key) => deleteMarker(context, key, before[key])),
			...added.map((key) => putMarker(context, key, data[key], id)),
		]);
		if (failed === undefined) return true;
		if (failed === 0) return false;
		throw uniqueViolation(context, added[failed - 1 - removed.length] ?? "id");
	}

	/** Whether `data` expired at `now` by the expiry key of `context`. */
	const isExpired = (
		context: RepositoryContext,
		data: RepositoryData,
		now: string | undefined,
	): boolean => {
		const expiry = expiryKeyOf(context);
		return (
			expiry !== undefined &&
			!matchesQuery(data, { withDeleted: true, now }, expiry)
		);
	};

	/** Logs an error that is not afora's own, then rethrows it. */
	const logged =
		<Args extends unknown[], Result>(
			operation: string,
			run: (context: RepositoryContext, ...args: Args) => Promise<Result>,
		) =>
		async (context: RepositoryContext, ...args: Args): Promise<Result> => {
			try {
				return await run(context, ...args);
			} catch (error) {
				if (!(error instanceof Exception)) {
					logger?.warn("dynamodb.error", {
						operation,
						repository: context.name,
						error: error instanceof Error ? error.name : String(error),
						message: error instanceof Error ? error.message : undefined,
					});
				}
				throw error;
			}
		};

	return {
		capabilities: Object.freeze({
			keyset: true,
			versioning: true,
			atomic: true,
			expiry: true,
		}),

		findOne: logged("findOne", async (context, query: ProviderQuery = {}) => {
			const [first] = selectRows(
				await candidates(context, query),
				{ ...query, limit: Math.min(query.limit ?? 1, 1) },
				expiryKeyOf(context),
			);
			return first;
		}),

		findMany: logged(
			"findMany",
			async (context, query: ProviderQuery = {}) =>
				(await pageInIdOrder(context, query)) ??
				selectRows(
					await candidates(context, query),
					query,
					expiryKeyOf(context),
				),
		),

		count: logged("count", async (context, query: ProviderQuery = {}) => {
			const expiry = expiryKeyOf(context);
			return (await candidates(context, query)).filter((data) =>
				matchesQuery(data, query, expiry),
			).length;
		}),

		insert: logged("insert", async (context, data: RepositoryData) => {
			const value = storable(data) as Record<string, unknown>;
			if (!(await create(context, value))) throw uniqueViolation(context, "id");
		}),

		update: logged(
			"update",
			async (
				context,
				data: RepositoryData,
				options: { readonly expectedVersion?: number } = {},
			) => {
				const value = storable(data) as Record<string, unknown>;
				const id = idOf(context, value);
				const expected = options.expectedVersion;
				for (let attempt = 1; attempt <= attempts; attempt++) {
					const previous = await getItem(context, id);
					if (!previous) throw notFound(context, id);
					const actual = previous.data.version;
					if (expected !== undefined && actual !== expected) {
						throw new RepositoryConcurrencyConflict({
							source: context.name,
							details: {
								id,
								expected,
								...(typeof actual === "number" ? { actual } : {}),
							},
						});
					}
					const equal =
						expected === undefined
							? undefined
							: ([["version", expected]] as const);
					if (await replace(context, previous, value, equal)) return;
				}
				exhausted(context, "update");
			},
		),

		remove: logged("remove", async (context, id: string) => {
			for (let attempt = 1; attempt <= attempts; attempt++) {
				const previous =
					typeof id === "string" && id.length > 0
						? await getItem(context, id)
						: undefined;
				if (!previous) throw notFound(context, id);
				const keys = markedKeys(context).filter((key) =>
					isPresent(previous.data[key]),
				);
				const failed = await write(context, [
					{
						Delete: {
							TableName,
							Key: entityKey(context, id),
							...unchanged(previous.m),
						},
					},
					...keys.map((key) => deleteMarker(context, key, previous.data[key])),
				]);
				if (failed === undefined) return;
			}
			exhausted(context, "remove");
		}),

		increment: logged(
			"increment",
			async (
				context,
				id: string,
				deltas: Readonly<Record<string, number>>,
				options: {
					readonly set?: RepositoryData;
					readonly create?: RepositoryData;
					readonly now?: string;
				} = {},
			) => {
				const marked = markedKeys(context);
				const set = storable(options.set ?? {}) as Record<string, unknown>;
				for (const key of [...Object.keys(deltas), ...Object.keys(set)]) {
					if (key === "id" || marked.includes(key)) {
						throw new InvalidRepositoryQuery({
							source: context.name,
							details: {
								reason: `increment cannot change the unique key "${key}" on DynamoDB.`,
							},
						});
					}
				}
				const names: Record<string, string> = {
					"#data": "data",
					"#deletedAt": "deletedAt",
				};
				const values: Record<string, unknown> = { ":null": "NULL" };
				const assignments: string[] = [];
				Object.entries(deltas).forEach(([key, delta], index) => {
					names[`#d${index}`] = key;
					values[`:d${index}`] = delta;
					values[":zero"] = 0;
					assignments.push(
						`#data.#d${index} = if_not_exists(#data.#d${index}, :zero) + :d${index}`,
					);
				});
				Object.entries(set).forEach(([key, value], index) => {
					if (Object.hasOwn(deltas, key)) return;
					names[`#s${index}`] = key;
					values[`:s${index}`] = value;
					assignments.push(`#data.#s${index} = :s${index}`);
				});
				const conditions = [
					"attribute_exists(pk)",
					"(attribute_not_exists(#data.#deletedAt) OR attribute_type(#data.#deletedAt, :null))",
				];
				const expiry = expiryKeyOf(context);
				if (expiry !== undefined) {
					// ISO 8601 dates of one format compare as strings.
					names["#expiry"] = expiry;
					values[":now"] = options.now ?? new Date().toISOString();
					conditions.push(
						"(attribute_not_exists(#data.#expiry) OR attribute_type(#data.#expiry, :null) OR #data.#expiry > :now)",
					);
				}
				for (let attempt = 1; attempt <= attempts; attempt++) {
					if (assignments.length > 0) {
						try {
							const { Attributes } = await db.send(
								new UpdateCommand({
									TableName,
									Key: entityKey(context, id),
									UpdateExpression: `SET ${assignments.join(", ")}`,
									ConditionExpression: conditions.join(" AND "),
									ExpressionAttributeNames: names,
									ExpressionAttributeValues: values,
									ReturnValues: "ALL_NEW",
								}),
							);
							return (Attributes as EntityItem).data;
						} catch (error) {
							const failure = writeFailureOf(error);
							if (failure === undefined) throw error;
							if (failure.kind === "conflict") {
								await sleep(backoffOf(attempt, baseDelayMs));
								continue;
							}
						}
					}
					const stored = await getItem(context, id);
					const alive =
						stored !== undefined &&
						!isPresent(stored.data.deletedAt) &&
						!isExpired(context, stored.data, options.now);
					if (alive && assignments.length === 0) return stored.data;
					if (!options.create) {
						if (alive) continue;
						throw notFound(context, id);
					}
					const created = storable({ ...options.create, id }) as Record<
						string,
						unknown
					>;
					if (!stored) {
						// Lost to a concurrent insert of the id: increment that one.
						if (await create(context, created)) return created;
						continue;
					}
					// A soft-deleted row keeps its id, as an insert finds.
					if (isPresent(stored.data.deletedAt))
						throw uniqueViolation(context, "id");
					if (alive) continue;
					// An expired row is replaced, unless it changed meanwhile.
					const at = (expiry === undefined ? undefined : stored.data[expiry]) as
						| unknown
						| undefined;
					if (
						await replace(
							context,
							stored,
							created,
							expiry === undefined || at === undefined
								? undefined
								: [[expiry, at]],
						)
					)
						return created;
				}
				return exhausted(context, "increment");
			},
		),

		async migrate() {
			// DynamoDB has no schema: items keep every key of their data
			// (`$v` included), old versions are upgraded on read and rewritten
			// by the backfill of `app.migrate`, and the rows of a previous name
			// stay in its own partition (`E#<previous name>Repository`).
		},
	} as DynamoDbProvider;
}
