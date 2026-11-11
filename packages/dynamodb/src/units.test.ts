import { describe, expect, test } from "bun:test";
import { batchGetAll, type ItemKey } from "./batch";
import { markerOf, markersOf, storable } from "./encoding";
import { backoffOf, writeFailureOf } from "./errors";
import { dynamoDbProvider, providers } from "./index";

describe("markerOf", () => {
	test("keeps the type of a value", () => {
		expect(markerOf(1)).toBe("1");
		expect(markerOf("1")).toBe('"1"');
		expect(markerOf(true)).toBe("true");
		expect(markerOf("true")).toBe('"true"');
		expect(markerOf(1)).not.toBe(markerOf("1"));
	});

	test("encodes structures by structure, whatever the order of their keys", () => {
		expect(markerOf({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		expect(markerOf({ a: 1, b: 2 })).toBe(markerOf({ b: 2, a: 1 }));
		expect(markerOf({ a: { d: 1, c: [2, { f: 1, e: 0 }] } })).toBe(
			'{"a":{"c":[2,{"e":0,"f":1}],"d":1}}',
		);
		expect(markerOf({ a: 1, b: undefined })).toBe(markerOf({ a: 1 }));
		expect(markerOf({})).not.toBe(markerOf("[object Object]"));
		expect(markerOf([1, 2])).not.toBe(markerOf([2, 1]));
	});

	test("markersOf lists the present unique values", () => {
		expect(
			markersOf({ email: "a", n: 1, gone: undefined, nil: null }, [
				"email",
				"n",
				"gone",
				"nil",
			]),
		).toBe(JSON.stringify({ email: '"a"', n: "1" }));
	});

	test("storable drops undefined and turns dates into ISO strings", () => {
		const at = new Date("2026-01-01T00:00:00.000Z");
		expect(
			storable({ a: undefined, b: [undefined, 1], c: { at }, d: null }),
		).toEqual({ b: [null, 1], c: { at: "2026-01-01T00:00:00.000Z" }, d: null });
	});
});

describe("writeFailureOf", () => {
	const named = (name: string, fields: object = {}) =>
		Object.assign(new Error(name), { name, ...fields });

	test("a failed condition of a single write is item 0", () => {
		expect(writeFailureOf(named("ConditionalCheckFailedException"))).toEqual({
			kind: "condition",
			index: 0,
		});
	});

	test("a cancelled transaction names the item whose condition failed", () => {
		const error = named("TransactionCanceledException", {
			CancellationReasons: [
				{ Code: "None" },
				{ Code: "None" },
				{ Code: "ConditionalCheckFailed" },
			],
		});
		expect(writeFailureOf(error)).toEqual({ kind: "condition", index: 2 });
	});

	test("conflicts are retried, anything else is not ours", () => {
		expect(
			writeFailureOf(
				named("TransactionCanceledException", {
					CancellationReasons: [{ Code: "TransactionConflict" }],
				}),
			),
		).toEqual({ kind: "conflict" });
		expect(writeFailureOf(named("TransactionConflictException"))).toEqual({
			kind: "conflict",
		});
		expect(
			writeFailureOf(
				named("TransactionCanceledException", {
					CancellationReasons: [{ Code: "ValidationError" }],
				}),
			),
		).toBe(undefined);
		expect(writeFailureOf(named("ResourceNotFoundException"))).toBe(undefined);
		expect(writeFailureOf("boom")).toBe(undefined);
	});

	test("backoff grows exponentially and is capped", () => {
		const top = () => 1;
		expect(backoffOf(1, 25, top)).toBe(25);
		expect(backoffOf(2, 25, top)).toBe(50);
		expect(backoffOf(4, 25, top)).toBe(200);
		expect(backoffOf(20, 25, top)).toBe(2_000);
		expect(backoffOf(3, 25, () => 0)).toBe(50);
	});
});

describe("batchGetAll", () => {
	const keys = (count: number): ItemKey[] =>
		Array.from({ length: count }, (_, index) => ({
			pk: "E#X",
			sk: String(index),
		}));

	test("chunks by 100 and asks again for unprocessed keys, with backoff", async () => {
		const sent: number[] = [];
		const delays: number[] = [];
		let calls = 0;
		const found = await batchGetAll(keys(150), {
			table: "t",
			attempts: 5,
			baseDelayMs: 10,
			sleep: async (ms) => {
				delays.push(ms);
			},
			send: async (batch) => {
				calls += 1;
				sent.push(batch.length);
				// The first answer of each chunk leaves its last 30 keys out.
				const left = calls === 1 || calls === 3 ? batch.slice(-30) : [];
				const done = batch.slice(0, batch.length - left.length);
				return {
					Responses: { t: done.map((key) => ({ ...key })) },
					UnprocessedKeys: { t: { Keys: left.map((key) => ({ ...key })) } },
				};
			},
			onExhausted: () => {
				throw new Error("exhausted");
			},
		});
		expect(sent).toEqual([100, 30, 50, 30]);
		expect(found).toHaveLength(150);
		expect(delays).toHaveLength(2);
	});

	test("gives up after the attempts", async () => {
		let calls = 0;
		const error = await batchGetAll(keys(3), {
			table: "t",
			attempts: 3,
			baseDelayMs: 0,
			sleep: async () => {},
			send: async (batch) => {
				calls += 1;
				return { UnprocessedKeys: { t: { Keys: [...batch] } } };
			},
			onExhausted: (attempts) => {
				throw new Error(`exhausted after ${attempts}`);
			},
		}).catch((e: Error) => e);
		expect((error as Error).message).toBe("exhausted after 3");
		expect(calls).toBe(3);
	});
});

describe("dynamoDbProvider", () => {
	test("needs a table and a client", () => {
		expect(() =>
			dynamoDbProvider({ table: "", client: {} } as never),
		).toThrow();
	});

	test("names the factory for codegen", () => {
		expect(providers).toEqual([
			{
				name: "dynamodb",
				module: "@afora/dynamodb",
				export: "dynamoDbProvider",
			},
		]);
	});
});
