import { afterAll, describe, expect, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	type RepositoryContext,
	RepositoryUniqueViolation,
	repositoryOf,
} from "@afora/core";
import { providerContract } from "@afora/core/testing";
import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
	DynamoDBDocumentClient,
	GetCommand,
	QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { dynamoDbProvider } from "./index";

/*
 * Runs against DynamoDB Local when DYNAMODB_ENDPOINT is set:
 *   docker run --rm -p 8000:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8000 bun test
 */
const endpoint = process.env.DYNAMODB_ENDPOINT;

if (!endpoint) {
	console.warn(
		"@afora/dynamodb: DYNAMODB_ENDPOINT is not set, so the tests against DynamoDB Local are skipped. Run `docker run --rm -p 8000:8000 amazon/dynamodb-local` and DYNAMODB_ENDPOINT=http://localhost:8000 bun test.",
	);
}

const client = new DynamoDBClient({
	endpoint: endpoint ?? "http://localhost:8000",
	region: process.env.AWS_REGION ?? "local",
	credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const tables: string[] = [];
let sequence = 0;

/** A fresh table, dropped once the file ran. */
async function freshTable(): Promise<string> {
	sequence += 1;
	const TableName = `afora-dynamodb-${Date.now()}-${sequence}`;
	tables.push(TableName);
	await client.send(
		new CreateTableCommand({
			TableName,
			BillingMode: "PAY_PER_REQUEST",
			AttributeDefinitions: [
				{ AttributeName: "pk", AttributeType: "S" },
				{ AttributeName: "sk", AttributeType: "S" },
			],
			KeySchema: [
				{ AttributeName: "pk", KeyType: "HASH" },
				{ AttributeName: "sk", KeyType: "RANGE" },
			],
		}),
	);
	return TableName;
}

afterAll(async () => {
	if (!endpoint) return;
	await Promise.all(
		tables.map((TableName) =>
			client.send(new DeleteTableCommand({ TableName })).catch(() => {}),
		),
	);
});

describe.skipIf(!endpoint)("DynamoDB provider contract", () => {
	providerContract({ describe, it: test, expect }, async () =>
		dynamoDbProvider({ table: await freshTable(), client }),
	);
});

describe.skipIf(!endpoint)("DynamoDB provider", () => {
	class Account extends entityOf(
		blueprintOf((ctx) => ({
			email: ctx.string,
			n: ctx.optionalOf(ctx.number),
		})),
		{ name: "Account" },
	) {}
	const context = (name: string, unique = ["id", "email"]) =>
		({
			entity: Account,
			name,
			unique,
			env: {},
		}) as unknown as RepositoryContext;

	test("keys items by the repository name, markers by key and typed value", async () => {
		const table = await freshTable();
		const provider = dynamoDbProvider({ table, client });
		const accounts = context("AccountRepository", ["id", "email", "n"]);
		await provider.insert(accounts, { id: "a", email: "a@x.io", n: 1 });
		const db = DynamoDBDocumentClient.from(client);
		const get = async (pk: string, sk: string) =>
			(await db.send(new GetCommand({ TableName: table, Key: { pk, sk } })))
				.Item;
		expect(await get("E#AccountRepository", "a")).toEqual({
			pk: "E#AccountRepository",
			sk: "a",
			data: { id: "a", email: "a@x.io", n: 1 },
			m: JSON.stringify({ email: '"a@x.io"', n: "1" }),
		});
		expect(await get("U#AccountRepository#email", '"a@x.io"')).toMatchObject({
			id: "a",
		});
		// 1 and "1" are different values: no collision.
		const other = context("AccountRepository", ["id", "email", "n"]);
		await provider.insert(other, { id: "b", email: "b@x.io", n: 2 });
		expect((await provider.findOne(accounts, { where: { n: 1 } }))?.id).toBe(
			"a",
		);
		expect(
			await provider.findOne(accounts, { where: { n: "1" } as never }),
		).toBe(undefined);
	});

	test("unique values of other types and structures do not collide", async () => {
		const provider = dynamoDbProvider({ table: await freshTable(), client });
		const tags = context("TagRepository", ["id", "code"]);
		await provider.insert(tags, { id: "a", email: "", code: 1 });
		await provider.insert(tags, { id: "b", email: "", code: "1" });
		await provider.insert(tags, { id: "c", email: "", code: { x: 1, y: 2 } });
		const error = await provider
			.insert(tags, { id: "d", email: "", code: { y: 2, x: 1 } })
			.catch((e: unknown) => e);
		expect(error instanceof RepositoryUniqueViolation).toBe(true);
		expect(
			(await provider.findOne(tags, { where: { code: { y: 2, x: 1 } } }))?.id,
		).toBe("c");
	});

	test("stores $v and unknown keys as they are, and reads them back", async () => {
		const provider = dynamoDbProvider({ table: await freshTable(), client });
		const posts = context("PostRepository");
		const data = { id: "p", email: "p@x.io", $v: 2, extra: { a: [1] } };
		await provider.insert(posts, data);
		expect(await provider.findOne(posts, { where: { id: "p" } })).toEqual(data);
		// A previous name is another partition.
		expect(await provider.count(context("OldPostRepository"))).toBe(0);
	});

	test("rejects a write of more than 100 items", async () => {
		const provider = dynamoDbProvider({ table: await freshTable(), client });
		const keys = Array.from({ length: 100 }, (_, index) => `k${index}`);
		const wide = context("WideRepository", ["id", ...keys]);
		const data = Object.fromEntries([
			["id", "w"],
			...keys.map((key) => [key, key]),
		]);
		const error = (await provider
			.insert(wide, data)
			.catch((e: unknown) => e)) as Error;
		expect(error.name).toBe("DynamoDbLimitExceeded");
		expect(error.message).toContain("100");
	});

	test("migrate is a no-op", async () => {
		const provider = dynamoDbProvider({ table: await freshTable(), client });
		await provider.migrate();
	});

	test("pages by id with Query limits, not one partition read per page", async () => {
		const db = DynamoDBDocumentClient.from(client, {
			marshallOptions: { removeUndefinedValues: true },
		});
		const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
		let queries = 0;
		let scanned = 0;
		(db as unknown as { send: typeof send }).send = async (command) => {
			const result = await send(command);
			if (command instanceof QueryCommand) {
				queries += 1;
				scanned += (result as { ScannedCount?: number }).ScannedCount ?? 0;
			}
			return result;
		};
		const provider = dynamoDbProvider({
			table: await freshTable(),
			client: db,
		});
		const items = context("ItemRepository", ["id"]);
		const ids = Array.from(
			{ length: 25 },
			(_, index) => `i${String(index).padStart(2, "0")}`,
		);
		for (const id of ids) {
			await provider.insert(items, {
				id,
				email: "",
				...(id === "i05" ? { deletedAt: "2026-01-01T00:00:00.000Z" } : {}),
			});
		}
		// The walk of app.migrate: by id, deleted rows too, 10 at a time.
		const walk = async (withDeleted: boolean) => {
			const pages: string[][] = [];
			let after: unknown[] | undefined;
			for (;;) {
				const rows = await provider.findMany(items, {
					orderBy: [{ key: "id", direction: "asc" }],
					withDeleted,
					limit: 10,
					...(after === undefined ? {} : { after }),
				});
				if (rows.length === 0) break;
				pages.push(rows.map((row) => String(row.id)));
				after = [rows.at(-1)?.id];
				if (rows.length < 10) break;
			}
			return pages;
		};
		queries = 0;
		scanned = 0;
		const pages = await walk(true);
		expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
		expect(pages.flat()).toEqual(ids);
		// Each item is read once: not the 75 of reading the partition per page.
		expect(scanned).toBeLessThanOrEqual(25);
		expect(queries).toBeLessThanOrEqual(4);

		// The deleted row is left out, and the page filled from the next items.
		const alive = await walk(false);
		expect(alive.map((page) => page.length)).toEqual([10, 10, 4]);
		expect(alive.flat()).toEqual(ids.filter((id) => id !== "i05"));
		// Without an order, a page of the partition is the same.
		expect(
			(await provider.findMany(items, { limit: 3 })).map((row) => row.id),
		).toEqual(["i00", "i01", "i02"]);
	});

	test("works under repositoryOf: unique keys, cursor, versions, increment", async () => {
		const provider = dynamoDbProvider({ table: await freshTable(), client });
		class Page extends entityOf(
			blueprintOf((ctx) => ({
				slug: ctx.string,
				title: ctx.string,
				views: ctx.integer,
			})),
			{
				name: "Page",
				unique: ["slug"],
				change: ["slug", "title", "views"],
				versioned: true,
			},
		) {}
		const Pages = repositoryOf({
			entity: Page,
			provider,
			actions: [
				"create",
				"findBySlug",
				"findCursor",
				"update",
				"increment",
				"delete",
			],
		});
		const page = await Pages.create(
			new Page({ slug: "a", title: "A", views: 0 }),
		);
		await Pages.create(new Page({ slug: "b", title: "B", views: 0 }));
		const duplicate = await Pages.create(
			new Page({ slug: "a", title: "again", views: 0 }),
		).catch((e: unknown) => e);
		expect(
			(duplicate as { is(e: unknown): boolean }).is(RepositoryUniqueViolation),
		).toBe(true);

		page.change.slug("c");
		await Pages.update(page);
		expect(await Pages.findBySlug("a")).toBe(undefined);
		expect((await Pages.findBySlug("c"))?.id).toBe(page.id);
		await Pages.create(new Page({ slug: "a", title: "free again", views: 0 }));

		const counted = await Pages.increment(page.id, { views: 2 });
		expect(counted.views).toBe(2);
		const first = await Pages.findCursor({
			orderBy: [{ key: "slug" }],
			limit: 2,
		});
		expect(first.items.map((item) => item.slug)).toEqual(["a", "b"]);
		const rest = await Pages.findCursor({
			orderBy: [{ key: "slug" }],
			limit: 2,
			after: first.next,
		});
		expect(rest.items.map((item) => item.slug)).toEqual(["c"]);

		await Pages.delete(counted);
		expect(await Pages.findBySlug("c")).toBe(undefined);
	});
});
