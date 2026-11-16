import { describe, expect, test } from "bun:test";
import {
	chosenStatusOf,
	compileRoutes,
	type HttpOptions,
	type HttpRequest,
	httpOptionsIssue,
	outputValueOf,
} from "../../adapters";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	InvalidOutputStage,
	InvalidUseCaseDeclaration,
	listOf,
	openapi,
	outputOf,
	Route,
	recordOf,
	useCaseOf,
	withStatus,
} from "../../index";

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

const Database = blueprintOf((ctx) => ({ latency: ctx.integer }));
const HealthResponse = blueprintOf((ctx) => ({
	ok: ctx.boolean,
	database: Database,
}));

class Health extends useCaseOf({
	name: "Health",
	blueprint: blueprintOf((ctx) => ({ up: ctx.boolean })),
	response: HealthResponse,
	route: { method: "get", path: "/health", statuses: [503] },
}) {
	override async execute() {
		const body = { ok: this.input.up, database: { latency: 3 } };
		return this.input.up ? body : withStatus(503, body);
	}
}

/** Chooses whatever status it is given, to try what the route refuses. */
class Chooser extends useCaseOf({
	name: "Chooser",
	blueprint: blueprintOf((ctx) => ({ status: ctx.integer })),
	response: listOf(Database),
	route: { method: "post", path: "/choose", status: 201, statuses: [200] },
}) {
	override async execute() {
		return withStatus(this.input.status, [{ latency: 1 }]);
	}
}

const Monitor = commandOf({
	name: "Monitor",
	useCases: { health: Health, choose: Chooser },
});
const output = outputOf({ name: "Api", commands: [Monitor] });
const stage = { output: { name: "Api", statuses: output.statuses } };
const routes = (options: HttpOptions = {}) =>
	compileRoutes(output.operations, options, stage, { source: "test" });
const request = (query: Record<string, string>, body?: unknown) =>
	({
		param: () => undefined,
		query: () => query,
		header: () => undefined,
		text: () => JSON.stringify(body ?? {}),
	}) satisfies HttpRequest;
const routeOf = (id: string, options?: HttpOptions) => {
	const found = routes(options).routes.find(
		({ operation }) => operation.id === id,
	);
	if (!found) throw new Error(id);
	return found;
};

describe("withStatus", () => {
	test("gives a view of the body for this call: the body itself has no status", () => {
		const body = Object.freeze({ ok: false, nested: { a: 1 } });
		const value = withStatus(503, body);
		expect(value).not.toBe(body);
		expect(value.ok).toBe(false);
		expect(value.nested).toBe(body.nested);
		expect(Object.keys(value)).toEqual(["ok", "nested"]);
		expect("ok" in value).toBe(true);
		expect(JSON.stringify(value)).toBe(JSON.stringify(body));
		expect(chosenStatusOf(value)).toBe(503);
		expect(chosenStatusOf(body)).toBeUndefined();
		expect(chosenStatusOf("text")).toBeUndefined();
		const list = withStatus(503, [1, 2]);
		expect(Array.isArray(list)).toBe(true);
		expect(list.map((item) => item * 2)).toEqual([2, 4]);
		expect(list).toHaveLength(2);
	});

	test("a record reads through the view: getters, methods and toJSON", () => {
		const Note = recordOf(
			blueprintOf((ctx) => ({ title: ctx.string, secret: ctx.password })),
		);
		const note = new Note({
			title: "t",
			secret:
				"$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$4VbQ3OqJ7xk8Y0mG0iZ1c2k1m2Qe0sQeJ7xk8Y0mG0i",
		});
		const view = withStatus(503, note);
		expect(view.title).toBe("t");
		expect(view instanceof Note).toBe(true);
		expect(view.toJSON()).toEqual(note.toJSON());
		expect(JSON.parse(JSON.stringify(view))).toEqual({
			title: "t",
			secret: "********",
		});
	});

	const shared = Object.freeze({ ok: true, database: { latency: 1 } });
	class Shared extends useCaseOf({
		name: "Shared",
		blueprint: blueprintOf((ctx) => ({
			down: ctx.boolean,
			fail: ctx.optional.boolean,
			wait: ctx.optional.integer,
		})),
		response: HealthResponse,
		route: { method: "get", path: "/shared", statuses: [503] },
	}) {
		override async execute() {
			const answer = this.input.down ? withStatus(503, shared) : shared;
			if (this.input.wait) {
				await new Promise((resolve) => setTimeout(resolve, this.input.wait));
			}
			if (this.input.fail) throw new Error("after withStatus");
			return answer;
		}
	}
	const sharedRoute = compileRoutes(
		outputOf({
			name: "Shared",
			commands: [commandOf({ name: "Shared", useCases: { get: Shared } })],
		}).operations,
		{},
		stage,
		{ source: "test" },
	).routes[0];
	const sharedRequest = (query: Record<string, string>) =>
		(sharedRoute as NonNullable<typeof sharedRoute>).handle(request(query));

	test("a status chosen before a throw does not reach the next call", async () => {
		const failed = await sharedRequest({ down: "true", fail: "true" });
		expect(failed.status).toBe(500);
		const next = await sharedRequest({ down: "false" });
		expect(next.status).toBe(200);
		expect(chosenStatusOf(shared)).toBeUndefined();
	});

	test("concurrent calls returning one shared body keep their own status", async () => {
		const [a, b] = await Promise.all([
			sharedRequest({ down: "true", wait: "10" }),
			sharedRequest({ down: "false", wait: "1" }),
		]);
		expect([a.status, b.status]).toEqual([503, 200]);
		expect(a.body).toBe(b.body);
	});

	test("steps: a later step that fails leaves no status behind", async () => {
		const Failing = exceptionOf({
			layer: ExceptionLayers.UseCase,
			name: "StepFailed",
			message: "failed",
		});
		const mark = () => withStatus(503, shared);
		const Steps = useCaseOf({
			name: "SharedSteps",
			blueprint: blueprintOf((ctx) => ({ fail: ctx.boolean })),
			response: HealthResponse,
			route: { method: "get", path: "/steps", statuses: [503] },
			errors: [Failing],
			steps: [
				{ run: "mark", fn: mark, as: "health" },
				{ ensure: "false", value: "$input.fail", error: Failing },
				{ return: "$health" },
			],
		});
		const [operation] = outputOf({
			name: "Steps",
			commands: [commandOf({ name: "Steps", useCases: { get: Steps } })],
		}).operations;
		await expect(operation?.invoke({ fail: true })).rejects.toMatchObject({
			name: "StepFailed",
		});
		expect(chosenStatusOf(shared)).toBeUndefined();
		expect(chosenStatusOf(await operation?.invoke({ fail: false }))).toBe(503);
	});

	test("a list of records as the body", async () => {
		const Item = recordOf(blueprintOf((ctx) => ({ name: ctx.string })));
		class Items extends useCaseOf({
			name: "Items",
			blueprint: blueprintOf(() => ({})),
			response: listOf(Item),
			route: { method: "get", path: "/items", statuses: [206] },
		}) {
			override async execute() {
				return withStatus(206, [new Item({ name: "a" })]);
			}
		}
		const direct = await new Items({}).execute();
		expect(direct.map((item) => item.name)).toEqual(["a"]);
		const [operation] = outputOf({
			name: "Items",
			commands: [commandOf({ name: "Items", useCases: { list: Items } })],
		}).operations;
		const value = await operation?.invoke({});
		expect(chosenStatusOf(value)).toBe(206);
		expect(outputValueOf(value)).toEqual([{ name: "a" }]);
	});

	test("a direct call gives the body only, validated against the response", async () => {
		const down = await new Health({ up: false }).execute();
		expect(down).toEqual({ ok: false, database: { latency: 3 } });
		expect(chosenStatusOf(down)).toBeUndefined();
		class Wrong extends useCaseOf({
			name: "Wrong",
			blueprint: blueprintOf(() => ({})),
			response: HealthResponse,
		}) {
			override async execute() {
				return withStatus(503, { ok: false } as never);
			}
		}
		await expect(new Wrong({}).execute()).rejects.toMatchObject({
			name: "InvalidUseCaseResponse",
		});
	});

	test("the events of the body are collected", async () => {
		class Probe extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {
			ping(): void {
				this.emit(Pinged);
			}
		}
		const Pinged = eventOf("Pinged", Probe, async () => {});
		class Ping extends useCaseOf({
			name: "Ping",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf(() => ({ probe: Probe })),
		}) {
			override async execute() {
				const probe = new Probe({ name: "db" });
				probe.ping();
				return withStatus(503, { probe });
			}
		}
		const useCase = new Ping({});
		await useCase.execute();
		expect(useCase.pullEvents().map(({ name }) => name)).toContain("Pinged");
	});

	test("a use case called as a dependency gives the body only", async () => {
		class Status extends useCaseOf({
			name: "Status",
			blueprint: blueprintOf(() => ({})),
			response: HealthResponse,
			dependencies: { health: Health },
		}) {
			override async execute(deps = this.dependencies) {
				return deps.health({ up: false });
			}
		}
		const value = await new Status({}).execute();
		expect(value).toEqual({ ok: false, database: { latency: 3 } });
		// A replacement of the child may choose a status too.
		const replaced = await new Status({}).execute({
			health: async () =>
				withStatus(503, { ok: true, database: { latency: 1 } }),
		});
		expect(replaced).toEqual({ ok: true, database: { latency: 1 } });
	});

	test("command.run gives the body, invoke the status with it", async () => {
		const ran = await Monitor.run("health", { up: false });
		expect(chosenStatusOf(ran)).toBeUndefined();
		expect(ran).toEqual({
			ok: false,
			database: { latency: 3 },
		});
		const operation = output.operations.find(
			({ id }) => id === "Monitor.health",
		);
		const down = await operation?.invoke({ up: false });
		expect(chosenStatusOf(down)).toBe(503);
		expect(outputValueOf(down)).toEqual({
			ok: false,
			database: { latency: 3 },
		});
		const up = await operation?.invoke({ up: true });
		expect(chosenStatusOf(up)).toBeUndefined();
	});

	test("steps choose a status with a run step that returns it", async () => {
		const check = (up: boolean) => {
			const body = { ok: up, database: { latency: 2 } };
			return up ? body : withStatus(503, body);
		};
		const Probe = useCaseOf({
			name: "Probe",
			blueprint: blueprintOf((ctx) => ({ up: ctx.boolean })),
			response: HealthResponse,
			route: { method: "get", path: "/probe", statuses: [503] },
			strictSteps: true,
			steps: [
				{
					run: "check",
					fn: check,
					args: ["$input.up"],
					as: "health",
				},
				{ return: "$health" },
			],
		});
		expect(await new Probe({ up: false }).execute()).toEqual({
			ok: false,
			database: { latency: 2 },
		});
		const [operation] = outputOf({
			name: "Steps",
			commands: [commandOf({ name: "Steps", useCases: { probe: Probe } })],
		}).operations;
		expect(chosenStatusOf(await operation?.invoke({ up: false }))).toBe(503);
	});

	test("types: execute accepts it and a direct call gives the body", () => {
		const call = () => new Health({ up: true }).execute();
		const body: Equals<
			Awaited<ReturnType<typeof call>>,
			{ ok: boolean; database: { latency: number } }
		> = true;
		const marked: { ok: boolean } = withStatus(503, { ok: false });
		const list: readonly number[] = withStatus(503, [1]);
		expect([body, marked.ok, list[0]]).toEqual([true, false, 1]);
	});
});

describe("route.statuses", () => {
	test("is kept by the route declaration", () => {
		expect(Health.route?.statuses).toEqual([503]);
		expect(Object.isFrozen(Health.route?.statuses)).toBe(true);
	});

	test("rejects what is not a status with a body, twice or the default", () => {
		const declare = (route: object) => () =>
			useCaseOf({
				name: "No",
				blueprint: blueprintOf(() => ({})),
				response: HealthResponse,
				route: { method: "get", ...route },
			});
		for (const statuses of [
			[100],
			[199],
			[204],
			[205],
			[301],
			[304],
			[400],
			[500],
			[600],
			[2.5],
			"503",
		]) {
			expect(declare({ statuses })).toThrow(
				"Expected route.statuses to be a list of statuses, each a 2xx with a body (not 204 or 205), a 4xx or a 5xx; not 1xx or 3xx, and not 400 or 500",
			);
		}
		expect(declare({ statuses: [206, 404, 409, 422, 503] })).not.toThrow();
		expect(declare({ statuses: [503, 503] })).toThrow(
			"route.statuses names a status twice.",
		);
		expect(declare({ statuses: [200] })).toThrow(
			"route.statuses names 200, the status of the route: list only the others.",
		);
		expect(declare({ status: 201, statuses: [201] })).toThrow(
			InvalidUseCaseDeclaration,
		);
		expect(() => Route("GET", "/x", { statuses: [503] })).not.toThrow();
	});

	test("the route option of a sink replaces them, checked against the status", () => {
		expect(
			httpOptionsIssue(
				{ route: { "Monitor.health": { statuses: [204] } } },
				"test",
			),
		).toStartWith(
			'Expected test.route["Monitor.health"].statuses to be a list of statuses',
		);
		expect(
			httpOptionsIssue(
				{ route: { "Monitor.health": { status: 202, statuses: [202] } } },
				"test",
			),
		).toContain("names 202, the status of the route");
		expect(
			httpOptionsIssue(
				{ route: { "Monitor.health": { statuses: [503] } } },
				"test",
			),
		).toBeUndefined();
		// 200 is the status the use case route gives Chooser.
		expect(() =>
			routes({ route: { "Monitor.choose": { status: 200 } } }),
		).toThrow(
			'test.route["Monitor.choose"] makes 200 its status, which its statuses list too',
		);
		expect(() =>
			routes({ route: { "Monitor.health": { statuses: [200] } } }),
		).toThrow(InvalidOutputStage);
	});
});

describe("HTTP", () => {
	test("sends the same body with 200 or 503", async () => {
		const route = routeOf("Monitor.health");
		const up = await route.handle(request({ up: "true" }));
		expect(up.status).toBe(200);
		expect(JSON.parse(up.body as string)).toEqual({
			ok: true,
			database: { latency: 3 },
		});
		const down = await route.handle(request({ up: "false" }));
		expect(down.status).toBe(503);
		expect(down.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(down.body as string)).toEqual({
			ok: false,
			database: { latency: 3 },
		});
	});

	test("an undeclared status is a masked 500, never sent", async () => {
		const route = routeOf("Monitor.choose");
		const listed = await route.handle(request({}, { status: 200 }));
		expect(listed.status).toBe(200);
		expect(JSON.parse(listed.body as string)).toEqual([{ latency: 1 }]);
		const own = await route.handle(request({}, { status: 201 }));
		expect(own.status).toBe(201);
		const other = await route.handle(request({}, { status: 418 }));
		expect(other.status).toBe(500);
		expect(JSON.parse(other.body as string)).toMatchObject({
			title: "UndeclaredStatus",
			detail: "Internal error.",
		});
		const debug = await routeOf("Monitor.choose", { debug: true }).handle(
			request({}, { status: 418 }),
		);
		expect(JSON.parse(debug.body as string).detail).toBe(
			"The status 418 is not declared by the route (201, 200): add it to route.statuses.",
		);
	});

	test("a 204 route sends its other statuses with a JSON body", async () => {
		const route = routeOf("Monitor.health", {
			route: { "Monitor.health": { status: 204 } },
		});
		const up = await route.handle(request({ up: "true" }));
		expect([up.status, up.body, up.headers["content-type"]]).toEqual([
			204,
			null,
			undefined,
		]);
		const down = await route.handle(request({ up: "false" }));
		expect(down.status).toBe(503);
		expect(down.headers["content-type"]).toBe("application/json");
	});
});

describe("OpenAPI", () => {
	test("one success per status, with the same content", () => {
		const document = output.pipe(
			openapi({ info: { title: "Api", version: "1" } }),
		) as { paths: Record<string, Record<string, { responses: object }>> };
		const health = document.paths["/health"]?.get?.responses as Record<
			string,
			{ description: string; content: Record<string, unknown> }
		>;
		expect(Object.keys(health)).toEqual(["200", "400", "500", "503"]);
		expect(health["503"]?.description).toBe(
			"Service unavailable. Chosen by the operation, with the response as its body.",
		);
		expect(health["503"]?.content).toEqual(
			health["200"]?.content as Record<string, unknown>,
		);
	});

	test("a status both chosen and a declared error gives the response or a problem", () => {
		const Locked = exceptionOf({
			layer: ExceptionLayers.UseCase,
			name: "Locked",
			message: "locked",
		});
		class Lock extends useCaseOf({
			name: "Lock",
			blueprint: blueprintOf(() => ({})),
			response: HealthResponse,
			errors: [Locked],
			route: { method: "get", path: "/lock", statuses: [422] },
		}) {
			override async execute() {
				return { ok: true, database: { latency: 1 } };
			}
		}
		const document = outputOf({
			name: "Lock",
			commands: [commandOf({ name: "Lock", useCases: { lock: Lock } })],
		}).pipe(openapi({ info: { title: "Api", version: "1" } })) as {
			paths: Record<string, Record<string, { responses: object }>>;
		};
		const lock = document.paths["/lock"]?.get?.responses as Record<
			string,
			{ description: string; content: Record<string, unknown> }
		>;
		expect(Object.keys(lock["422"]?.content ?? {})).toEqual([
			"application/json",
			"application/problem+json",
		]);
		expect(lock["422"]?.description).toBe(
			"Unprocessable content. Chosen by the operation, with the response as its body. Or a problem: Declared error of the operation. Declared: Locked.",
		);
	});
});
