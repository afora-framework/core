/**
 * The public surface of the package, snapshotted: every name exported by
 * `dist/index.d.ts` (re-exports resolved) with its declaration text, with the
 * declarations they reference that are not exported (`(internal) Name`), plus the
 * `afora.json` JSON Schema of `packages/codegen`. After 1.0 a change here is a
 * breaking or additive change to the contract: review it, then update the
 * snapshot on purpose (`bun run test:api -u`).
 *
 * Reads `dist/`: run through `bun run test:api`, which builds it first.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiSurface } from "./surface";

const root = join(import.meta.dir, "../..");
const entry = join(root, "dist/index.d.ts");
const experimentalEntry = join(root, "dist/experimental.d.ts");
const testingEntry = join(root, "dist/testing/index.d.ts");

if (
	!existsSync(entry) ||
	!existsSync(experimentalEntry) ||
	!existsSync(testingEntry)
)
	throw new Error("dist/ is missing: run `bun run test:api`.");

test("exports of the package and their declarations", () => {
	const surface = apiSurface(entry);
	expect(Object.keys(surface).length).toBeGreaterThan(0);
	expect(surface).toMatchSnapshot();
});

// Not the contract: `@afora/core/experimental` may change in any release (see
// VERSIONING.md). Snapshotted only so a change is seen and reviewed.
test("experimental entry (not contract)", () => {
	const surface = apiSurface(experimentalEntry);
	expect(Object.keys(surface).length).toBeGreaterThan(0);
	expect(surface).toMatchSnapshot();
});

// Part of the contract: `@afora/core/testing` is what provider packages run
// their implementations against.
test("testing entry (contract)", () => {
	const surface = apiSurface(testingEntry);
	expect(Object.keys(surface).length).toBeGreaterThan(0);
	expect(surface).toMatchSnapshot();
});

test("afora.json schema", async () => {
	const schema = await Bun.file(
		join(root, "packages/codegen/afora.schema.json"),
	).json();
	expect(sorted(schema)).toMatchSnapshot();
});

/** Object keys in a stable order, so reordering the file is not a change. */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, sorted(item)]),
		);
	return value;
}
