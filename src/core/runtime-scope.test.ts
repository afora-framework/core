import { afterEach, describe, expect, test } from "bun:test";
import { configure, Id, resetRuntime, withRuntime } from "../index";
import { manualClock } from "../testing/clock";
import { currentTime } from "./clock";
import { activeRuntime, resetRuntimeScopes } from "./runtime-scope";

const idOf = (n: number) =>
	`01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

afterEach(() => {
	resetRuntime();
	resetRuntimeScopes();
});

describe.each([
	["with AsyncLocalStorage", true],
	["without AsyncLocalStorage", false],
] as const)("withRuntime %s", (_, asyncContext) => {
	const fresh = () => resetRuntimeScopes({ asyncContext });

	test("gives fn the services and what fn returns", () => {
		fresh();
		const clock = manualClock("2030-01-01T00:00:00.000Z");
		const value = withRuntime({ idGenerator: () => idOf(1), clock }, () => ({
			id: Id.generate().value,
			now: currentTime(),
		}));
		expect(value).toEqual({ id: idOf(1), now: clock.now() });
		expect(Id.generate().value).not.toBe(idOf(1));
		expect(activeRuntime()).toBeUndefined();
	});

	test("nests, the inner call winning the services it gives", () => {
		fresh();
		const clock = manualClock("2030-01-01T00:00:00.000Z");
		withRuntime({ idGenerator: () => idOf(1), clock }, () => {
			withRuntime({ idGenerator: () => idOf(2) }, () => {
				expect(Id.generate().value).toBe(idOf(2));
				expect(currentTime()).toBe(clock.now());
			});
			expect(Id.generate().value).toBe(idOf(1));
		});
	});

	test("restores the outer services when fn throws", () => {
		fresh();
		withRuntime({ idGenerator: () => idOf(1) }, () => {
			expect(() =>
				withRuntime({ idGenerator: () => idOf(2) }, () => {
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(Id.generate().value).toBe(idOf(1));
		});
		expect(activeRuntime()).toBeUndefined();
	});

	test("covers the synchronous part of an async fn, and restores when it rejects", async () => {
		fresh();
		const seen: string[] = [];
		const running = withRuntime({ idGenerator: () => idOf(1) }, async () => {
			seen.push(Id.generate().value);
			throw new Error("boom");
		});
		expect(Id.generate().value).not.toBe(idOf(1));
		await expect(running).rejects.toThrow("boom");
		expect(seen).toEqual([idOf(1)]);
		expect(activeRuntime()).toBeUndefined();
	});

	test("comes before configure", () => {
		fresh();
		configure({ idGenerator: () => idOf(9) });
		expect(
			withRuntime({ idGenerator: () => idOf(1) }, () => Id.generate().value),
		).toBe(idOf(1));
		expect(withRuntime({}, () => Id.generate().value)).toBe(idOf(9));
	});
});

describe("withRuntime with AsyncLocalStorage", () => {
	test("follows fn across awaits, nested calls included", async () => {
		const outer = await withRuntime(
			{ idGenerator: () => idOf(1) },
			async () => {
				await tick();
				const inner = await withRuntime(
					{ idGenerator: () => idOf(2) },
					async () => {
						await tick();
						return Id.generate().value;
					},
				);
				await tick();
				return [inner, Id.generate().value];
			},
		);
		expect(outer).toEqual([idOf(2), idOf(1)]);
	});

	test("keeps concurrent calls apart", async () => {
		const run = (n: number) =>
			withRuntime({ idGenerator: () => idOf(n) }, async () => {
				const ids: string[] = [];
				for (let i = 0; i < 3; i++) {
					await tick();
					ids.push(Id.generate().value);
				}
				return ids;
			});
		const [a, b] = await Promise.all([run(1), run(2)]);
		expect(a).toEqual([idOf(1), idOf(1), idOf(1)]);
		expect(b).toEqual([idOf(2), idOf(2), idOf(2)]);
	});

	test("restores the outer services after an awaited rejection", async () => {
		await withRuntime({ idGenerator: () => idOf(1) }, async () => {
			await expect(
				withRuntime({ idGenerator: () => idOf(2) }, async () => {
					await tick();
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(Id.generate().value).toBe(idOf(1));
		});
	});
});

describe("withRuntime without AsyncLocalStorage", () => {
	test("leaves fn after its first await", async () => {
		resetRuntimeScopes({ asyncContext: false });
		const ids = await withRuntime({ idGenerator: () => idOf(1) }, async () => {
			const before = Id.generate().value;
			await tick();
			return [before, Id.generate().value];
		});
		expect(ids[0]).toBe(idOf(1));
		expect(ids[1]).not.toBe(idOf(1));
	});
});

test("withRuntime rejects what is not a runtime service", () => {
	expect(() => withRuntime({ clock: 1 } as never, () => 0)).toThrow(TypeError);
	expect(() => withRuntime({ hasher: {} } as never, () => 0)).toThrow(
		TypeError,
	);
	expect(() => withRuntime({ other: () => 0 } as never, () => 0)).toThrow(
		'Unknown runtime service "other"',
	);
	expect(() => withRuntime({}, 1 as never)).toThrow(TypeError);
});

test("no scope is looked for until one is entered", () => {
	resetRuntimeScopes();
	expect(activeRuntime()).toBeUndefined();
});
