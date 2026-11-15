import { describe, expect, expectTypeOf, test } from "bun:test";
import { compileRoutes, type HttpRequest } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	Exception,
	environmentOf,
	InvalidUseCaseDeclaration,
	InvalidUseCaseDependencies,
	isService,
	outputOf,
	ServiceNotBound,
	type ServiceScope,
	serviceOf,
	UnregisteredUseCaseDependency,
	type UseCaseDependencies,
	useCaseOf,
} from "../../index";

interface CacheClient {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
}

function memoryCache(): CacheClient {
	const values = new Map<string, string>();
	return {
		get: (key) => values.get(key),
		set: (key, value) => {
			values.set(key, value);
		},
	};
}

const Cache = serviceOf<CacheClient>("cache");
const Clock = serviceOf<{ now(): number }>("clock");

const Key = blueprintOf((ctx) => ({ key: ctx.string }));
const Found = blueprintOf((ctx) => ({ value: ctx.optional.string }));

class Remember extends useCaseOf({
	name: "Remember",
	blueprint: Key,
	response: blueprintOf(() => ({})),
	dependencies: { cache: Cache },
}) {
	override async execute() {
		this.dependencies.cache.set(this.input.key, "remembered");
		return {};
	}
}

class Recall extends useCaseOf({
	name: "Recall",
	blueprint: Key,
	response: Found,
	dependencies: { cache: Cache, remember: Remember },
}) {
	override async execute({
		cache = this.dependencies.cache,
		remember = this.dependencies.remember,
	} = {}) {
		await remember({ key: this.input.key });
		return { value: cache.get(this.input.key) };
	}
}

describe("serviceOf", () => {
	test("is a frozen declaration, told apart by its brand", () => {
		expect(Cache.name).toBe("cache");
		expect(Object.isFrozen(Cache)).toBe(true);
		expect(isService(Cache)).toBe(true);
		expect(isService({ name: "cache" })).toBe(false);
		expect(() => serviceOf("not a name")).toThrow(InvalidUseCaseDeclaration);
	});

	test("types the dependency as the value of the service", () => {
		expectTypeOf<
			UseCaseDependencies<typeof Recall>["cache"]
		>().toEqualTypeOf<CacheClient>();
	});
});

describe("services as dependencies", () => {
	test("an override of execute wins, outside an application", async () => {
		const cache = memoryCache();
		cache.set("a", "given");
		await expect(
			new Recall({ key: "a" }).execute({
				cache,
				remember: async () => ({}),
			}),
		).resolves.toEqual({ value: "given" });
	});

	test("reading a service nothing binds throws ServiceNotBound", async () => {
		const error = await new Recall({ key: "a" })
			.execute({ remember: async () => ({}) })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Exception);
		expect((error as Exception).is(ServiceNotBound)).toBe(true);
		expect((error as Exception).details).toEqual({ service: "cache" });
		// Not read, not thrown.
		class Unused extends useCaseOf({
			name: "Unused",
			blueprint: Key,
			response: Found,
			dependencies: { cache: Cache },
		}) {
			override async execute() {
				return {};
			}
		}
		await expect(new Unused({ key: "a" }).execute()).resolves.toEqual({});
	});

	test("an override must be a value", async () => {
		await expect(
			new Recall({ key: "a" }).execute({ cache: undefined }),
		).rejects.toThrow(InvalidUseCaseDependencies);
	});

	test("an application makes each service once per call, shared by the use cases it runs", async () => {
		let made = 0;
		const App = applicationOf({
			name: "cached",
			useCases: { Recall, Remember },
			services: {
				cache: async () => {
					made++;
					return memoryCache();
				},
			},
		});
		const Bound = App.useCases.Recall;
		await expect(new Bound({ key: "a" }).execute()).resolves.toEqual({
			value: "remembered",
		});
		expect(made).toBe(1);
		await new Bound({ key: "b" }).execute();
		expect(made).toBe(2);
		// The override wins, for the use case that gets it.
		const own = memoryCache();
		own.set("c", "own");
		await expect(
			new Bound({ key: "c" }).execute({
				cache: own,
				remember: async () => ({}),
			}),
		).resolves.toEqual({ value: "own" });
	});

	test("a command call gives the factory its context, logger and environments", async () => {
		const Env = environmentOf(
			blueprintOf((ctx) => ({ CACHE_PREFIX: ctx.string })),
			{ source: () => ({ CACHE_PREFIX: "p:" }) },
		);
		const scopes: ServiceScope[] = [];
		class Read extends useCaseOf({
			name: "Read",
			blueprint: Key,
			response: Found,
			context: blueprintOf((ctx) => ({ tenant: ctx.string })),
			dependencies: { clock: Clock, env: Env },
		}) {
			override async execute() {
				return { value: String(this.dependencies.clock.now()) };
			}
		}
		const Reads = commandOf({
			name: "Reads",
			context: blueprintOf((ctx) => ({ tenant: ctx.string })),
			useCases: { read: Read },
		});
		const App = applicationOf({
			name: "clocked",
			environments: { Env },
			useCases: { Read },
			commands: { Reads },
			services: {
				clock: (scope) => {
					scopes.push(scope);
					return { now: () => 42 };
				},
			},
		});
		const result = await App.commands.Reads.execute(
			"read",
			{ key: "a" },
			{ context: { tenant: "t1" } },
		);
		expect(result.value).toEqual({ value: "42" });
		const [scope] = scopes;
		expect(scope?.name).toBe("clock");
		expect(scope?.context).toEqual({ tenant: "t1" });
		expect(scope?.principal).toBeUndefined();
		expect(typeof scope?.logger.info).toBe("function");
		expect(scope?.environment(Env)).toEqual({ CACHE_PREFIX: "p:" });
	});

	test("a factory that fails fails the call", async () => {
		const App = applicationOf({
			name: "failing",
			useCases: { Recall, Remember },
			services: {
				cache: () => {
					throw new Error("down");
				},
			},
		});
		await expect(
			new App.useCases.Recall({ key: "a" }).execute(),
		).rejects.toThrow("down");
	});

	test("an application requires every service its use cases declare", () => {
		expect(() =>
			applicationOf({ name: "missing", useCases: { Recall, Remember } }),
		).toThrow(UnregisteredUseCaseDependency);
		expect(() =>
			applicationOf({
				name: "bad",
				useCases: { Remember },
				services: { cache: "nope" as never },
			}),
		).toThrow("Expected the service");
	});

	test("an extending application inherits the services", async () => {
		const Base = applicationOf({
			name: "base",
			services: { cache: () => memoryCache() },
		});
		const App = applicationOf({
			name: "child",
			extends: [Base],
			useCases: { Recall, Remember },
		});
		await expect(
			new App.useCases.Recall({ key: "a" }).execute(),
		).resolves.toEqual({ value: "remembered" });
		expect(App.describe().services).toEqual({ cache: { from: "base" } });
	});

	test("describe() reports a service by its name", () => {
		const App = applicationOf({
			name: "described",
			useCases: { Recall, Remember },
			services: { cache: () => memoryCache() },
		});
		const description = App.describe();
		expect(description.useCases.Recall?.dependencies).toEqual({
			cache: { kind: "service", ref: "cache" },
			remember: { kind: "use-case", ref: "Remember" },
		});
		expect(description.services).toEqual({ cache: { from: "described" } });
	});

	test("an HTTP call gives the factory who calls and the native request", async () => {
		const seen: { principal: unknown; native: unknown }[] = [];
		class Stamp extends useCaseOf({
			name: "Stamp",
			blueprint: Key,
			response: Found,
			dependencies: { clock: Clock },
			route: { method: "get", path: "/stamp" },
			access: { scopes: [] },
		}) {
			override async execute() {
				return { value: String(this.dependencies.clock.now()) };
			}
		}
		const App = applicationOf({
			name: "http",
			useCases: { Stamp },
			commands: {
				Stamps: commandOf({ name: "Stamps", useCases: { stamp: Stamp } }),
			},
			services: {
				clock: ({ principal, native }) => {
					seen.push({ principal, native });
					return { now: () => (native as { at: number }).at };
				},
			},
		});
		const output = outputOf({ name: "Api", commands: [App.commands.Stamps] });
		const table = compileRoutes(
			output.operations,
			{},
			{ output: { name: "Api", statuses: {} } },
			{
				source: "test",
				authenticator: () => ({ subject: "ana", scopes: [] }),
			},
		);
		const route = table.routes[0];
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({ key: "a" }),
			header: () => undefined,
			text: () => "",
			native: { at: 7 },
		};
		const result = await route?.handle(request);
		expect(result?.status).toBe(200);
		expect(JSON.parse(result?.body as string)).toEqual({ value: "7" });
		expect(seen).toEqual([
			{ principal: { subject: "ana", scopes: [] }, native: { at: 7 } },
		]);
	});
});
