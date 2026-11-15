import { describe, expect, it, test } from "bun:test";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
} from "../../adapters";
import { providerDescriptionOf } from "../../experimental";
import {
	blueprintOf,
	entityOf,
	type InMemoryProvider,
	InvalidRepositoryDeclaration,
	inMemoryProvider,
	type ProviderCall,
	type ProviderInterceptor,
	type ProviderOperation,
	providersOf,
	wrapProvider,
} from "../../index";
import { providerContract } from "../../testing";
import { PROVIDER_OPERATIONS } from "./wrap";

class Item extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
const context: RepositoryContext = {
	entity: Item,
	name: "ItemRepository",
	unique: ["id"],
	env: undefined,
};
const row = (id: string): RepositoryData => ({ id, name: id });

const passthrough: ProviderInterceptor = {
	around: (_call, next) => next(),
};

/** An interceptor writing `<label>:<operation>` before and `<label>:end` after each call. */
function recorder(label: string, log: string[]): ProviderInterceptor {
	return {
		async around({ operation }, next) {
			log.push(`${label}:${operation}`);
			try {
				return await next();
			} finally {
				log.push(`${label}:end`);
			}
		},
	};
}

/** A provider with only the required operations. */
function minimal(): IRepositoryProvider {
	const { findOne, findMany, insert, update, remove, count } =
		inMemoryProvider();
	return { findOne, findMany, insert, update, remove, count };
}

describe("wrapProvider", () => {
	test("runs around each operation with its context and arguments", async () => {
		const calls: ProviderCall[] = [];
		const provider = wrapProvider(inMemoryProvider(), {
			around(call, next) {
				calls.push(call);
				return next();
			},
		});
		await provider.insert(context, row("a"));
		expect(await provider.findOne(context, { where: { id: "a" } })).toEqual(
			row("a"),
		);
		expect(await provider.count(context)).toBe(1);
		expect(calls.map((call) => call.operation)).toEqual([
			"insert",
			"findOne",
			"count",
		]);
		expect(calls[0]?.context).toBe(context);
		expect(calls[0]?.args).toEqual([row("a")]);
		expect(Object.isFrozen(calls[0]?.args)).toBe(true);
		expect(calls[1]?.args).toEqual([{ where: { id: "a" } }]);
		expect(calls[2]?.args).toEqual([]);
	});

	test("passes the value of next through, and around may replace it or the error", async () => {
		const provider = wrapProvider(inMemoryProvider(), {
			async around({ operation }, next) {
				// Replacing a result takes a cast: only next() gives the operation's type.
				if (operation === "count")
					return 42 as Awaited<ReturnType<typeof next>>;
				try {
					return await next();
				} catch {
					throw new Error(`${operation} failed`);
				}
			},
		});
		expect(await provider.count(context)).toBe(42);
		await expect(provider.remove(context, "missing")).rejects.toThrow(
			"remove failed",
		);
	});

	test("an interceptor throwing synchronously rejects the operation", async () => {
		const provider = wrapProvider(inMemoryProvider(), {
			around() {
				throw new Error("boom");
			},
		});
		await expect(provider.count(context)).rejects.toThrow("boom");
	});

	test("optional operations stay absent when the provider has none", () => {
		const provider = wrapProvider(minimal(), passthrough);
		for (const key of ["increment", "migrate", "transaction", "close"]) {
			expect(key in provider).toBe(false);
		}
		expect(provider.capabilities).toBeUndefined();
		expect(Object.isFrozen(provider)).toBe(true);
	});

	test("optional operations are kept when the provider has them", async () => {
		let closed = 0;
		const inner = { ...inMemoryProvider(), close: () => void closed++ };
		const log: string[] = [];
		const provider = wrapProvider(inner, recorder("x", log));
		expect(typeof provider.increment).toBe("function");
		expect(typeof provider.transaction).toBe("function");
		await provider.insert(context, { ...row("a"), visits: 1 });
		expect(
			await provider.increment?.(context, "a", { visits: 2 }),
		).toMatchObject({ visits: 3 });
		await provider.close?.();
		expect(closed).toBe(1);
		// close takes no context and is not intercepted.
		expect(log).toEqual(["x:insert", "x:end", "x:increment", "x:end"]);
	});

	test("intercepts the operations of the provider a transaction gives", async () => {
		const log: string[] = [];
		const provider = wrapProvider(inMemoryProvider(), recorder("x", log));
		const result = await provider.transaction?.(async (child) => {
			await child.insert(context, row("a"));
			await child.transaction?.(async (nested) => {
				await nested.count(context);
			});
			return "done";
		});
		expect(result).toBe("done");
		expect(log).toEqual(["x:insert", "x:end", "x:count", "x:end"]);
		expect(await provider.count(context)).toBe(1);
	});

	test("two wraps compose, the last one outermost", async () => {
		const log: string[] = [];
		const provider = wrapProvider(
			wrapProvider(inMemoryProvider(), recorder("inner", log)),
			recorder("outer", log),
		);
		await provider.count(context);
		expect(log).toEqual([
			"outer:count",
			"inner:count",
			"inner:end",
			"outer:end",
		]);
		log.length = 0;
		await provider.transaction?.((child) => child.count(context));
		expect(log).toEqual([
			"outer:count",
			"inner:count",
			"inner:end",
			"outer:end",
		]);
	});

	test("capabilities are read live, other members kept", () => {
		let keyset = false;
		const inner = {
			...minimal(),
			get capabilities() {
				return { keyset };
			},
			label: "dynamo",
			describe() {
				return this.label;
			},
		};
		const provider = wrapProvider(inner, passthrough);
		expect(provider.capabilities?.keyset).toBe(false);
		keyset = true;
		expect(provider.capabilities?.keyset).toBe(true);
		expect(provider.label).toBe("dynamo");
		expect(provider.describe()).toBe("dynamo");
	});

	test("keeps the methods of a class-based provider bound to it", async () => {
		const memory = inMemoryProvider();
		class Store implements IRepositoryProvider {
			#memory = memory;
			findOne: IRepositoryProvider["findOne"] = (...args) =>
				this.#memory.findOne(...args);
			findMany: IRepositoryProvider["findMany"] = (...args) =>
				this.#memory.findMany(...args);
			insert: IRepositoryProvider["insert"] = (...args) =>
				this.#memory.insert(...args);
			update: IRepositoryProvider["update"] = (...args) =>
				this.#memory.update(...args);
			remove: IRepositoryProvider["remove"] = (...args) =>
				this.#memory.remove(...args);
			count(ctx: RepositoryContext) {
				return this.#memory.count(ctx);
			}
			size() {
				return this.#memory.count(context);
			}
		}
		const provider = wrapProvider(new Store(), passthrough);
		await provider.insert(context, row("a"));
		expect(await provider.count(context)).toBe(1);
		expect(await provider.size()).toBe(1);
	});

	test("keeps the declaration of a named provider", () => {
		const provider = wrapProvider(inMemoryProvider(), passthrough);
		expect(providerDescriptionOf(provider)).toEqual({
			kind: "provider",
			name: "inMemory",
			options: {},
		});
	});

	test("rejects a provider of providersOf, which only an application binds", () => {
		const Providers = providersOf({ main: inMemoryProvider() });
		expect(() => wrapProvider(Providers.main, passthrough)).toThrow(
			InvalidRepositoryDeclaration,
		);
		expect(() => wrapProvider(Providers.main, passthrough)).toThrow(
			/providersOf cannot be wrapped/,
		);
		// Wrapping the provider before giving it to providersOf works.
		const Wrapped = providersOf({
			main: wrapProvider(inMemoryProvider(), passthrough),
		});
		expect(typeof Wrapped.main.findOne).toBe("function");
	});

	test("a slot of providersOf forwards only the operations and capabilities", () => {
		const inner = { ...inMemoryProvider(), label: "x", extra: () => 1 };
		const slot = providersOf({ main: inner }).main as unknown as Record<
			string,
			unknown
		>;
		expect("label" in slot).toBe(false);
		expect("extra" in slot).toBe(false);
		expect(typeof slot.findOne).toBe("function");
		expect(slot.capabilities).toBe(inner.capabilities);
	});

	test("rejects what is not a provider or an interceptor", () => {
		expect(() => wrapProvider(null as never, passthrough)).toThrow(
			InvalidRepositoryDeclaration,
		);
		expect(() => wrapProvider(inMemoryProvider(), {} as never)).toThrow(
			InvalidRepositoryDeclaration,
		);
	});

	test("lists every operation taking a context", () => {
		type Listed = (typeof PROVIDER_OPERATIONS)[number];
		// Both directions: the list and the union are the same names.
		const exact: [ProviderOperation] extends [Listed]
			? [Listed] extends [ProviderOperation]
				? true
				: false
			: false = true;
		expect(exact).toBe(true);
		// The union is the members of IRepositoryProvider taking a context first.
		type TakingContext = {
			[Key in keyof IRepositoryProvider]-?: NonNullable<
				IRepositoryProvider[Key]
			> extends (first: infer First, ...args: never[]) => unknown
				? [First] extends [RepositoryContext]
					? Key
					: never
				: never;
		}[keyof IRepositoryProvider];
		const derived: [TakingContext] extends [ProviderOperation]
			? [ProviderOperation] extends [TakingContext]
				? true
				: false
			: false = true;
		expect(derived).toBe(true);
		expect(PROVIDER_OPERATIONS).toHaveLength(8);
	});

	test("types: the same provider type, args narrowed by operation", () => {
		const provider: InMemoryProvider = wrapProvider(
			inMemoryProvider(),
			passthrough,
		);
		expect(provider.capabilities.transactions).toBe(true);
		wrapProvider(inMemoryProvider(), {
			async around(call, next) {
				switch (call.operation) {
					case "remove": {
						const id: string = call.args[0];
						expect(typeof id).toBe("string");
						break;
					}
					case "findOne":
					case "findMany":
					case "insert":
					case "update":
					case "count":
					case "increment":
					case "migrate":
						break;
					default: {
						const never: never = call;
						return never;
					}
				}
				return next();
			},
		});
		wrapProvider(inMemoryProvider(), {
			// @ts-expect-error around must give what next() gives
			async around(_call, next) {
				await next();
			},
		});
		const typed = wrapProvider({} as IRepositoryProvider<{ url: string }>, {
			around: ({ context }, next) => {
				const url: string = context.env.url;
				return url ? next() : next();
			},
		});
		expect(typed).toBeDefined();
	});
});

describe("wrapProvider(inMemoryProvider(), passthrough)", () => {
	providerContract({ describe, it, expect }, () =>
		wrapProvider(inMemoryProvider(), passthrough),
	);
});
