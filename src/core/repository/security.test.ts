import { describe, expect, test } from "bun:test";
import type { IRepositoryProvider } from "../../adapters";
import {
	blueprintOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidRepositoryQuery,
	repositoryOf,
	useCaseOf,
} from "../../index";

class Member extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		email: ctx.email,
		code: ctx.optional.string,
		team: ctx.optional.string,
	})),
	{ name: "Member", unique: ["email", "code"] },
) {}

class Task extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string, owner: Member })),
	{ name: "Task" },
) {}

/** A repository whose provider counts the reads it is asked for. */
async function seeded() {
	const Members = repositoryOf({
		entity: Member,
		actions: ["findByCode", "findManyByTeam", "findById", "create"],
	});
	await Members.create({ name: "Ana", email: "ana@example.com" });
	await Members.create({
		name: "Bia",
		email: "bia@example.com",
		code: "code-bia",
		team: "core",
	});
	return Members;
}

describe("SEC-20: findBy<Key> and findManyBy<Key> with a missing value", () => {
	test("SEC-20: findBy<Key>(undefined) and findBy<Key>(null) give undefined", async () => {
		const Members = await seeded();
		expect(await Members.findByCode(undefined as never)).toBeUndefined();
		expect(await Members.findByCode(null as never)).toBeUndefined();
		expect((await Members.findByCode("code-bia"))?.name).toBe("Bia");
	});

	test("SEC-20: findManyBy<Key>(undefined) and findManyBy<Key>(null) give no entity", async () => {
		const Members = await seeded();
		expect(await Members.findManyByTeam(undefined as never)).toEqual([]);
		expect(await Members.findManyByTeam(null as never)).toEqual([]);
		expect(await Members.findManyByTeam("core")).toHaveLength(1);
	});

	test("SEC-20: the provider is not asked for a missing value", async () => {
		const reads: string[] = [];
		const Members = await seeded();
		const provider = (Members as unknown as { provider: IRepositoryProvider })
			.provider;
		const original = { findOne: provider.findOne, findMany: provider.findMany };
		provider.findOne = (...args) => {
			reads.push("findOne");
			return original.findOne.apply(provider, args);
		};
		provider.findMany = (...args) => {
			reads.push("findMany");
			return original.findMany.apply(provider, args);
		};
		await Members.findByCode(undefined as never);
		await Members.findManyByTeam(null as never);
		expect(reads).toEqual([]);
	});

	test("SEC-20: a declarative use case given no value finds nothing", async () => {
		const Members = await seeded();
		const NotFound = exceptionOf({
			layer: ExceptionLayers.UseCase,
			name: "NotFound",
			message: "No member has this code.",
		});
		class WhoseCode extends useCaseOf({
			name: "WhoseCode",
			blueprint: blueprintOf((ctx) => ({ code: ctx.optional.string })),
			response: blueprintOf((ctx) => ({ email: ctx.string })),
			dependencies: { members: Members },
			errors: [NotFound],
			steps: [
				{ find: "members.findByCode", args: ["$input.code"], as: "found" },
				{ ensure: "exists", value: "$found", error: NotFound },
				{ return: { email: "$found.email" } },
			],
		}) {}
		const run = async (input: object) => {
			try {
				return await new WhoseCode(input as never).execute();
			} catch (error) {
				return (error as Error).name;
			}
		};
		expect(await run({ code: "code-bia" })).toEqual({
			email: "bia@example.com",
		});
		expect(await run({})).toBe("NotFound");
	});

	test("SEC-20: findBy<Key> still takes an entity or its id for a reference key", async () => {
		const Members = await seeded();
		const owner = await Members.create({
			name: "Caio",
			email: "caio@example.com",
		});
		const Tasks = repositoryOf({
			entity: Task,
			actions: ["findManyByOwner", "create"],
			relations: [Members],
		});
		await Tasks.create({ title: "Ship", owner });
		expect(await Tasks.findManyByOwner(owner)).toHaveLength(1);
		expect(await Tasks.findManyByOwner(owner.id)).toHaveLength(1);
		expect(await Tasks.findManyByOwner(undefined as never)).toEqual([]);
	});
});

describe("SEC-21: findBy<Key> and findManyBy<Key> take one value", () => {
	test("SEC-21: an { in } object is not read as a membership", async () => {
		const Members = await seeded();
		const many = { in: ["nope", "code-bia"] };
		await expect(Members.findByCode(many as never)).rejects.toBeInstanceOf(
			InvalidRepositoryQuery,
		);
		await expect(
			Members.findManyByTeam({ in: ["core"] } as never),
		).rejects.toBeInstanceOf(InvalidRepositoryQuery);
	});
});

describe("SEC-47: a write checks that the entities it references exist", () => {
	class Review extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.string,
			owner: Member,
			reviewers: ctx.listOf(Member),
			score: ctx.number,
		})),
		{ name: "Review", change: ["score", "owner"] },
	) {}

	async function setup() {
		const reads: string[] = [];
		const Members = repositoryOf({
			entity: Member,
			actions: ["create", "delete"],
		});
		const ana = await Members.create({ name: "Ana", email: "ana@example.com" });
		const bia = await Members.create({ name: "Bia", email: "bia@example.com" });
		const provider = (Members as unknown as { provider: IRepositoryProvider })
			.provider;
		const findMany = provider.findMany;
		provider.findMany = (...args) => {
			reads.push("findMany");
			return findMany.apply(provider, args);
		};
		const Tasks = repositoryOf({
			entity: Task,
			actions: ["create", "update", "findMany"],
			relations: [Members],
		});
		const Reviews = repositoryOf({
			entity: Review,
			actions: ["create", "update", "findMany", "increment"],
			relations: [Members],
		});
		return { Members, Tasks, Reviews, ana, bia, reads };
	}

	const unsaved = () => new Member({ name: "Caio", email: "caio@example.com" });

	test("SEC-47: create rejects a reference to an id that was never stored", async () => {
		const { Tasks, ana } = await setup();
		await Tasks.create({ title: "Ship", owner: ana });
		const error = await Tasks.create({ title: "Ghost", owner: unsaved() }).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect((error as Error).name).toBe("RepositoryEntityNotFound");
		const titles = (await Tasks.findMany({})).map((task) => task.title);
		expect(titles).toEqual(["Ship"]);
	});

	test("SEC-47: update rejects a reference to an id that was never stored", async () => {
		const { Reviews, ana, bia } = await setup();
		const review = await Reviews.create({
			title: "Draft",
			owner: ana,
			reviewers: [bia],
			score: 1,
		});
		review.change.owner(unsaved());
		await expect(Reviews.update(review)).rejects.toMatchObject({
			name: "RepositoryEntityNotFound",
		});
		const [stored] = await Reviews.findMany({});
		expect(stored?.owner.name).toBe("Ana");
	});

	test("SEC-47: a reference in a list is checked too", async () => {
		const { Reviews, ana, bia } = await setup();
		await expect(
			Reviews.create({
				title: "Draft",
				owner: ana,
				reviewers: [bia, unsaved()],
				score: 1,
			}),
		).rejects.toMatchObject({ name: "RepositoryEntityNotFound" });
		expect(await Reviews.findMany({})).toEqual([]);
	});

	test("SEC-47: the entity increment creates is checked", async () => {
		const { Reviews, ana } = await setup();
		const id = new Review({
			title: "x",
			owner: ana,
			reviewers: [],
			score: 0,
		}).id;
		await expect(
			Reviews.increment(
				id,
				{ score: 1 },
				{ create: { title: "New", owner: unsaved(), reviewers: [] } },
			),
		).rejects.toMatchObject({ name: "RepositoryEntityNotFound" });
		expect(await Reviews.findMany({})).toEqual([]);
	});

	test("SEC-47: the references of a write are read in one batch per relation", async () => {
		const { Reviews, ana, bia, reads } = await setup();
		await Reviews.create({
			title: "Draft",
			owner: ana,
			reviewers: [ana, bia],
			score: 1,
		});
		expect(reads).toEqual(["findMany"]);
	});

	test("SEC-47: a soft-deleted entity can still be referenced", async () => {
		const Members = repositoryOf({
			entity: Member,
			actions: ["create", "delete"],
			deletion: "soft",
		});
		const Tasks = repositoryOf({
			entity: Task,
			actions: ["create", "findMany"],
			relations: [Members],
		});
		const ana = await Members.create({ name: "Ana", email: "ana@example.com" });
		await Members.delete(ana);
		await Tasks.create({ title: "Ship", owner: ana });
		expect((await Tasks.findMany({}))[0]?.owner.name).toBe("Ana");
	});

	test("SEC-47: a use case given a plain entity value of an unknown id stores nothing", async () => {
		const { Tasks } = await setup();
		class AddTask extends useCaseOf({
			name: "AddTask",
			blueprint: blueprintOf((ctx) => ({ title: ctx.string, owner: Member })),
			response: blueprintOf((ctx) => ({ title: ctx.string })),
			dependencies: { tasks: Tasks },
			steps: [
				{ create: "tasks", value: "$input", as: "task" },
				{ return: { title: "$task.title" } },
			],
		}) {}
		const owner = unsaved().toJSON();
		await expect(
			new AddTask({ title: "Ghost", owner } as never).execute(),
		).rejects.toMatchObject({ name: "RepositoryEntityNotFound" });
		expect(await Tasks.findMany({})).toEqual([]);
	});
});
