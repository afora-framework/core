import { describe, expect, test } from "bun:test";
import { blueprintOf, entityOf } from "@afora/core";
import type { RepositoryContext } from "@afora/core/adapters";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamoDbProvider } from "../src/index";

describe("SEC-46: a missing value in where", () => {
	class Account extends entityOf(
		blueprintOf((ctx) => ({ email: ctx.string, code: ctx.optional.string })),
		{ name: "Account" },
	) {}
	const context = {
		entity: Account,
		name: "AccountRepository",
		unique: ["id", "email", "code"],
		env: {},
	} as unknown as RepositoryContext;
	/** A provider whose client fails any request, so a read that reaches it throws. */
	const provider = () => {
		const client = DynamoDBDocumentClient.from(
			new DynamoDBClient({
				region: "us-east-1",
				endpoint: "http://127.0.0.1:9",
				credentials: { accessKeyId: "test", secretAccessKey: "test" },
			}),
		);
		client.send = (() =>
			Promise.reject(new Error("The table was read."))) as never;
		return dynamoDbProvider({ table: "accounts", client });
	};

	test("SEC-46: undefined or null matches no row without reading the table", async () => {
		const accounts = provider();
		for (const missing of [undefined, null]) {
			const where = { code: missing };
			expect(await accounts.findMany(context, { where })).toEqual([]);
			expect(await accounts.findOne(context, { where })).toBeUndefined();
			expect(await accounts.count(context, { where })).toBe(0);
			expect(
				await accounts.findMany(context, {
					where: { email: "a@example.com", id: missing },
				}),
			).toEqual([]);
		}
	});
});
