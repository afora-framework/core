import { describe, expect, it, test } from "bun:test";
import { RepositoryUniqueViolation } from "@afora/core";
import { providerContract } from "@afora/core/testing";
import { allTitles, Entries } from "./recipes/cursor-pagination.ts";
import { Product, Sku } from "./recipes/custom-property.ts";
import { countingProvider } from "./recipes/custom-provider.ts";
import { Listed } from "./recipes/custom-sink-or-stage.ts";
import { appWith } from "./recipes/domain-events.ts";
import {
	EmailTaken,
	fakeMembers,
	Join,
	Member,
} from "./recipes/override-repository-method.ts";
import { archiveAndBring } from "./recipes/soft-delete.ts";
import { createPage, Pages } from "./recipes/tenant-uniqueness.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("recipes: each page shows the code of its file", async () => {
	const names = [
		"soft-delete",
		"cursor-pagination",
		"tenant-uniqueness",
		"domain-events",
		"custom-property",
		"custom-provider",
		"custom-sink-or-stage",
		"override-repository-method",
	];
	for (const name of names) {
		const source = (await read(`./recipes/${name}.ts`)).trim();

		expect(await read(`../../docs/recipes/${name}.md`)).toContain(source);
	}
});

test("soft delete: reads skip the row, withDeleted sees it, restore brings it back", async () => {
	const { hidden, all, back } = await archiveAndBring("first");

	expect(hidden).toBeUndefined();
	expect(all).toHaveLength(1);
	expect(all[0]?.isDeleted).toBe(true);
	expect(back.isDeleted).toBe(false);
	expect(back.title).toBe("first");
});

test("cursor pagination: every page, none repeated, the last has no next", async () => {
	for (const title of ["c", "a", "b", "e", "d"]) {
		await Entries.create({ title });
	}

	expect(await allTitles(2)).toEqual(["a", "b", "c", "d", "e"]);
	const last = await Entries.findCursor({
		orderBy: [{ key: "title" }],
		limit: 10,
	});
	expect(last.next).toBeUndefined();
	const first = await Entries.findCursor({
		orderBy: [{ key: "title" }],
		limit: 2,
	});
	expect(first.items.map((entry) => entry.title)).toEqual(["a", "b"]);
	expect(first.next).toBeString();
});

test("tenant uniqueness: the same slug in two tenants, not twice in one", async () => {
	await createPage("t1", "home");
	await createPage("t2", "home");

	const duplicate = await createPage("t1", "home").catch((error) => error);
	expect(duplicate).toBeInstanceOf(RepositoryUniqueViolation);
	expect(duplicate.details.key).toBe("slugKey");
	expect(await Pages.findManyByTenantId("t1")).toHaveLength(1);
	expect((await Pages.findBySlugKey("t2:home"))?.tenantId).toBe("t2");
});

test("domain events: the event reaches the publisher after the call", async () => {
	const published: { topic: string; event: unknown }[] = [];
	const app = appWith({
		publish(topic, event) {
			published.push({ topic, event });
		},
	});
	await app.start({ replace: true });

	await app.commands.Shop.run("place", { item: "mug" });

	expect(published).toHaveLength(1);
	expect(published[0]?.topic).toBe("Shop/order.placed");
	expect(published[0]?.event).toMatchObject({
		name: "order.placed",
		command: "Shop",
		operation: "place",
	});
});

test("custom property: normalizes, rejects and is unique", () => {
	expect(Product.safeParse({ sku: " mug-0001 ", name: "Mug" })).toEqual({
		value: { sku: "MUG-0001", name: "Mug" },
	});
	const bad = Product.safeParse({ sku: "mug", name: "Mug" });
	expect(bad.issues?.[0]?.path).toEqual(["sku"]);
	expect(Sku.demo().value).toBe("MUG-0001");
});

describe("custom provider", () => {
	it("counts what the repository asks of it", async () => {
		const { provider, calls } = countingProvider();
		const { blueprintOf, entityOf, repositoryOf } = await import("@afora/core");
		class Tag extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.text })),
			{ unique: ["name"] },
		) {}
		const Tags = repositoryOf({
			entity: Tag,
			actions: ["create", "findById"],
			provider,
		});

		const tag = await Tags.create({ name: "bun" });
		await Tags.findById(tag.id);

		expect(calls.insert).toBe(1);
		expect(calls.findOne).toBe(1);
	});

	// The contract of a provider: what a provider author runs
	providerContract({ describe, it, expect }, () => countingProvider().provider);
});

test("custom stage and sink: the transform labels, the sink lists", () => {
	const built = Listed.build();

	expect(built.output).toBe("Listed");
	expect(built.labels).toEqual([
		"todo:Todo.create",
		"todo:Todo.get",
		"todo:Todo.list",
		"todo:Todo.update",
		"todo:Todo.delete",
	]);
});

describe("override a repository method in a test", () => {
	const input = { name: "Ana", email: "ana@example.com" };

	it("a fake that finds a member makes Join refuse", async () => {
		const error = await new Join(input)
			.execute({ members: fakeMembers(new Member(input)) })
			.catch((caught) => caught);

		expect(error.is(EmailTaken)).toBe(true);
	});

	it("a fake that finds none lets Join create", async () => {
		const { member } = await new Join(input).execute({
			members: fakeMembers(),
		});

		expect(member.email).toBe("ana@example.com");
	});
});
