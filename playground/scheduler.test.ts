import { expect, test } from "bun:test";
import { languageQueue, stale } from "./scheduler";

test("drops requests superseded by a newer buffer version", async () => {
	const queue = languageQueue();
	const ran: string[] = [];
	const old = queue.run(() => ran.push("old"), { version: 1 });
	const current = queue.run(() => ran.push("current") && "ok", {
		version: 2,
	});
	expect(await old).toBe(stale);
	expect(await current).toBe("ok");
	expect(ran).toEqual(["current"]);
	// An outdated request arriving later is dropped as well.
	expect(await queue.run(() => "late", { version: 1 })).toBe(stale);
	expect(await queue.run(() => "same", { version: 2 })).toBe("same");
});

test("a newer request arriving while one waits supersedes it", async () => {
	const queue = languageQueue();
	const first = queue.run(() => "first", { version: 1 });
	await Promise.resolve();
	const second = queue.run(() => "second", { version: 2 });
	expect(await first).toBe(stale);
	expect(await second).toBe("second");
});

test("runs interactive requests before pending diagnostics", async () => {
	const queue = languageQueue();
	const ran: string[] = [];
	const results = await Promise.all([
		queue.run(() => ran.push("diagnostics"), { version: 1 }),
		queue.run(() => ran.push("complete"), { version: 1, interactive: true }),
		queue.run(() => ran.push("hover"), { version: 1, interactive: true }),
	]);
	expect(results).not.toContain(stale);
	expect(ran).toEqual(["complete", "hover", "diagnostics"]);
});

test("drops aborted requests and propagates errors", async () => {
	const queue = languageQueue();
	const controller = new AbortController();
	const aborted = queue.run(() => "never", {
		version: 1,
		signal: controller.signal,
	});
	controller.abort();
	expect(await aborted).toBe(stale);
	expect(
		queue.run(() => {
			throw new Error("Unknown language service action");
		}),
	).rejects.toThrow("Unknown language service action");
	expect(await queue.run(() => "unversioned")).toBe("unversioned");
});
