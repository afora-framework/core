import { describe, expect, test } from "bun:test";
import {
	compileRoutes,
	type HttpRequest,
	type IRepositoryProvider,
} from "../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidRepositoryDeclaration,
	inMemoryProvider,
	outputOf,
	providersOf,
	repositoryOf,
	useCaseOf,
} from "../index";
import { spyProvider } from "./spy";

class Project extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{ name: "Project" },
) {}
class Setting extends entityOf(
	blueprintOf((ctx) => ({ key: ctx.string })),
	{ name: "Setting" },
) {}

const StoreDown = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "StoreDown",
	message: "The store is down.",
});

describe("spyProvider", () => {
	test("records the calls of a repository, by entity and operation", async () => {
		const spy = spyProvider(inMemoryProvider());
		const Projects = repositoryOf({
			entity: Project,
			provider: spy,
			actions: ["create", "findMany", "count"],
		});
		const Settings = repositoryOf({
			entity: Setting,
			provider: spy,
			actions: ["count"],
		});

		await Projects.create({ title: "a" });
		await Projects.findMany();
		await Projects.findMany();
		await Settings.count();

		expect(spy.calls("Project", "findMany")).toHaveLength(2);
		expect(spy.calls(Project, "insert")).toHaveLength(1);
		expect(spy.calls(Setting).map((call) => call.operation)).toEqual(["count"]);
		expect(spy.calls().length).toBeGreaterThanOrEqual(4);
		const [insert] = spy.calls(Project, "insert");
		expect(insert?.entity).toBe("Project");
		expect(insert?.args[0]).toMatchObject({ title: "a" });

		spy.reset();
		expect(spy.calls()).toEqual([]);
	});

	test("fails an operation, every time or `times` times", async () => {
		const spy = spyProvider(inMemoryProvider());
		const Projects = repositoryOf({
			entity: Project,
			provider: spy,
			actions: ["count", "findMany"],
		});
		const down = new StoreDown({ source: "test" });

		spy.fail(Project, "count", down, { times: 2 });
		expect(await Projects.count().catch((error) => error)).toBeInstanceOf(
			StoreDown,
		);
		expect(await Projects.count().catch((error) => error)).toBeInstanceOf(
			StoreDown,
		);
		expect(await Projects.count()).toBe(0);
		expect(await Projects.findMany()).toEqual([]);
		expect(spy.calls(Project, "count")).toHaveLength(3);

		spy.fail("Project", "findMany", down);
		for (let i = 0; i < 3; i++)
			expect(await Projects.findMany().catch((error) => error)).toBeInstanceOf(
				StoreDown,
			);
		spy.reset();
		expect(await Projects.findMany()).toEqual([]);

		for (const times of [0, -1, 1.5, Number.NaN])
			expect(() => spy.fail(Project, "count", down, { times })).toThrow(
				InvalidRepositoryDeclaration,
			);
		spy.fail(Project, "count", down, { times: Number.POSITIVE_INFINITY });
		spy.reset();
	});

	test("refuses an operation the provider does not have", () => {
		const memory = inMemoryProvider();
		const withoutIncrement: IRepositoryProvider = {
			findOne: (context, query) => memory.findOne(context, query),
			findMany: (context, query) => memory.findMany(context, query),
			insert: (context, data) => memory.insert(context, data),
			update: (context, data, options) => memory.update(context, data, options),
			remove: (context, id) => memory.remove(context, id),
			count: (context, query) => memory.count(context, query),
		};
		const spy = spyProvider(withoutIncrement);
		expect(() =>
			spy.fail(Project, "increment", new StoreDown({ source: "test" })),
		).toThrow(InvalidRepositoryDeclaration);
		expect(() =>
			spy.fail(Project, "count", new StoreDown({ source: "test" })),
		).not.toThrow();
	});

	test("records the calls inside a transaction", async () => {
		const spy = spyProvider(inMemoryProvider());
		const Projects = repositoryOf({
			entity: Project,
			provider: spy,
			actions: ["create", "count"],
		});
		class Seed extends useCaseOf({
			name: "Seed",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { Projects },
		}) {
			override async execute({ Projects = this.dependencies.Projects } = {}) {
				await Projects.create({ title: "a" });
				await Projects.create({ title: "b" });
				return { total: await Projects.count() };
			}
		}
		const Seeder = commandOf({
			name: "Seeder",
			useCases: { seed: Seed },
			transaction: true,
		});

		expect(await Seeder.run("seed", {})).toEqual({ total: 2 });
		expect(spy.calls(Project, "insert")).toHaveLength(2);
		expect(spy.calls(Project, "count")).toHaveLength(1);

		spy.reset();
		const context = {
			entity: Project,
			name: "ProjectRepository",
			unique: ["id"],
			env: undefined,
		};
		await spy.transaction?.(async (child) => {
			await child.count(context);
			await child.transaction?.((nested) => nested.findMany(context));
		});
		expect(spy.calls().map((call) => call.operation)).toEqual([
			"count",
			"findMany",
		]);
	});

	test("is the provider: same members, frozen, refused for a slot", async () => {
		const memory = inMemoryProvider();
		const spy = spyProvider(memory);
		expect(Object.isFrozen(spy)).toBe(true);
		expect(spy.capabilities).toEqual(memory.capabilities);
		expect(typeof spy.transaction).toBe("function");
		for (const member of ["calls", "fail", "reset"])
			expect(() =>
				spyProvider({ ...memory, [member]: () => {} } as never),
			).toThrow(InvalidRepositoryDeclaration);
		const storage = providersOf({ main: inMemoryProvider() });
		expect(() => spyProvider(storage.main as never)).toThrow(
			InvalidRepositoryDeclaration,
		);
	});

	test("fails a count behind an HTTP sink with the status of the output", async () => {
		const Settings = repositoryOf({ entity: Setting, actions: ["count"] });
		class CountSettings extends useCaseOf({
			name: "CountSettings",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { Settings },
			route: { method: "get", path: "/settings/count" },
		}) {
			override async execute({ Settings = this.dependencies.Settings } = {}) {
				return { total: await Settings.count() };
			}
		}
		const Admin = commandOf({
			name: "Admin",
			useCases: { count: CountSettings },
		});
		const spy = spyProvider(inMemoryProvider());
		const app = applicationOf({
			name: "cms",
			entities: { Setting },
			repositories: { Settings },
			useCases: { CountSettings },
			commands: { Admin },
			provider: spy,
		});
		const Api = outputOf({
			name: "Api",
			commands: [app.commands.Admin],
			statuses: { StoreDown: 503 },
		});
		const [route] = compileRoutes(
			Api.operations,
			{},
			{ output: { name: "Api", statuses: Api.statuses } },
			{ source: "test" },
		).routes;
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({}),
			header: () => undefined,
			text: () => "",
		};

		expect((await route?.handle(request))?.status).toBe(200);
		expect(spy.calls(Setting, "count")).toHaveLength(1);

		spy.fail(Setting, "count", new StoreDown({ source: "test" }));
		const failed = await route?.handle(request);
		expect(failed?.status).toBe(503);
		expect(JSON.parse(failed?.body ?? "null")).toMatchObject({
			title: "StoreDown",
			status: 503,
		});
	});
});
