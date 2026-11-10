import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	type CommandInput,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	Logger,
	repositoryOf,
	StdUseCases,
	statusOf,
} from "../../index";

const TypeNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "TypeNotFound",
	message: "No such content type.",
});
const Locked = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Locked",
	message: "The entry is locked.",
});

class ContentType extends entityOf(
	blueprintOf((ctx) => ({ slug: ctx.slug })),
	{ unique: ["slug"] },
) {}

class Entry extends entityOf(
	blueprintOf((ctx) => ({
		type: ctx.string,
		title: ctx.string,
		locked: ctx.boolean,
	})),
	{
		change: ["title", "locked"],
		plugins: (ctx) => [ctx.publishable, ctx.taggable],
	},
) {}

function domain() {
	const provider = inMemoryProvider();
	const Types = repositoryOf({
		entity: ContentType,
		provider,
		actions: ["findBySlug", "create"],
	});
	const Entries = repositoryOf({
		entity: Entry,
		provider,
		deletion: "soft",
		actions: ["findById", "findPage", "create", "update", "delete", "restore"],
	});
	return { Types, Entries };
}

describe("before and after", () => {
	test("before checks and replaces the input, after runs with the entity written", async () => {
		const { Types, Entries } = domain();
		await Types.create(new ContentType({ slug: "post" }));
		const seen: unknown[] = [];
		const Create = StdUseCases.context.create(Entries, {
			omit: ["publishedAt"],
			values: { locked: false },
			dependencies: { types: Types },
			throws: [TypeNotFound],
			before: async ({ input, dependencies, context }) => {
				expectTypeOf(input).toEqualTypeOf<{
					readonly type: string;
					readonly title: string;
					readonly tags?: string[] | undefined;
				}>();
				expectTypeOf(context).toEqualTypeOf<undefined>();
				const type = await dependencies.types.findBySlug(input.type);
				if (!type) throw new TypeNotFound({ source: input.type });
				return { ...input, title: input.title.trim() };
			},
			after: ({ entity, input }) => {
				expectTypeOf(entity).toEqualTypeOf<Entry>();
				seen.push(entity.title, input.title);
			},
		});
		expect(Create.errors).toEqual([TypeNotFound]);
		expect(Object.keys(Create.dependencies)).toEqual(["repository", "types"]);

		const { item } = await new Create({
			type: "post",
			title: "  Hello ",
		}).execute();
		expect(item.title).toBe("Hello");
		expect(seen).toEqual(["Hello", "Hello"]);

		const missing = await new Create({ type: "page", title: "x" })
			.execute()
			.catch((error) => error);
		expect(missing).toBeInstanceOf(TypeNotFound);
		expect(statusOf(missing, Create)).toBe(422);

		// The dependencies of the hooks can be overridden as any other.
		const overridden = await new Create({ type: "page", title: "y" }).execute({
			types: { findBySlug: async () => new ContentType({ slug: "page" }) },
		});
		expect(overridden.item.type).toBe("page");
	});

	test("before of a use case over one entity gets it, and its replacement is what changes", async () => {
		const { Entries } = domain();
		const entry = await Entries.create(
			new Entry({ type: "post", title: "A", locked: true }),
		);
		const Update = StdUseCases.context.update(Entries, {
			throws: [Locked],
			before: ({ input, entity }) => {
				expectTypeOf(entity).toEqualTypeOf<Entry>();
				if (entity.locked && input.locked !== false) {
					throw new Locked({ source: entity.id });
				}
				return { ...input, title: input.title?.toUpperCase() };
			},
		});
		await expect(
			new Update({ id: entry.id, title: "b" }).execute(),
		).rejects.toBeInstanceOf(Locked);
		const { item } = await new Update({
			id: entry.id,
			title: "b",
			locked: false,
		}).execute();
		expect(item.title).toBe("B");
		expect(item.locked).toBe(false);
	});

	test("before that gives nothing back keeps the input", async () => {
		const { Entries } = domain();
		const entry = await Entries.create(
			new Entry({ type: "post", title: "A", locked: false }),
		);
		let checked = false;
		const Tag = StdUseCases.context.tag(Entries, {
			before: ({ input }) => {
				checked = input.tags.length > 0;
			},
		});
		const { item } = await new Tag({ id: entry.id, tags: ["x"] }).execute();
		expect(checked).toBe(true);
		expect(item.tags).toEqual(["x"]);
	});

	test("delete, restore and the lifecycle ones take them too", async () => {
		const { Entries } = domain();
		const entry = await Entries.create(
			new Entry({ type: "post", title: "A", locked: false }),
		);
		const log: string[] = [];
		const after =
			(name: string) =>
			({ entity }: { readonly entity: Entry }) => {
				log.push(`${name}:${entity.isPublished}:${Boolean(entity.deletedAt)}`);
			};
		const Publish = StdUseCases.context.publish(Entries, {
			after: after("publish"),
		});
		const Delete = StdUseCases.context.delete(Entries, {
			before: ({ entity }) => {
				log.push(`before delete ${entity.id === entry.id}`);
			},
			after: after("delete"),
		});
		const Restore = StdUseCases.context.restore(Entries, {
			before: ({ input }) => {
				log.push(`before restore ${input.id === entry.id}`);
			},
			after: after("restore"),
		});
		await new Publish({ id: entry.id }).execute();
		await new Delete({ id: entry.id }).execute();
		await new Restore({ id: entry.id }).execute();
		expect(log).toEqual([
			"publish:true:false",
			"before delete true",
			"delete:true:true",
			"before restore true",
			"restore:true:false",
		]);
	});

	test("after runs within the transaction of the command", async () => {
		const { Entries } = domain();
		const Failing = exceptionOf({
			layer: ExceptionLayers.UseCase,
			name: "Failing",
			message: "after failed.",
		});
		const Cms = commandOf({
			name: "Cms",
			transaction: true,
			useCases: (ctx) => ({
				create: ctx.create(Entries, {
					omit: ["publishedAt"],
					throws: [Failing],
					after: async ({ entity, dependencies }) => {
						expect(await dependencies.repository.findById(entity.id)).toEqual(
							entity,
						);
						throw new Failing({ source: entity.id });
					},
				}),
			}),
		});
		const error = await Cms.run("create", {
			type: "post",
			title: "Gone",
			locked: false,
		}).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(Failing);
		expect((await Entries.findPage({})).total).toBe(0);
		expectTypeOf<CommandInput<typeof Cms, "create">>().toEqualTypeOf<{
			readonly type: string;
			readonly title: string;
			readonly locked: boolean;
			readonly tags?: string[] | undefined;
		}>();
	});

	test("register checks the email the input before gives", async () => {
		class Account extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
			{ plugins: (ctx) => [ctx.authenticatable] },
		) {}
		const Accounts = repositoryOf({
			entity: Account,
			provider: inMemoryProvider(),
			actions: ["findByEmail", "create"],
		});
		const Register = StdUseCases.context.register(Accounts, {
			before: ({ input }) => ({ ...input, email: input.email.toLowerCase() }),
		});
		const input = {
			name: "Ana",
			email: "ANA@example.com",
			password: "Demo@123",
		};
		const { item } = await new Register(input).execute();
		expect(item.email).toBe("ana@example.com");
		const taken = await new Register(input).execute().catch((error) => error);
		expect(taken.name).toBe("UseCaseEntityConflict");
	});

	test("the hooks run as steps, described as opaque functions", () => {
		const { Types, Entries } = domain();
		const Cms = commandOf({
			name: "Cms",
			useCases: (ctx) => ({
				update: ctx.update(Entries, {
					dependencies: { types: Types, logger: Logger },
					throws: [Locked],
					before: () => {},
					after: () => {},
				}),
			}),
		});
		const App = applicationOf({
			name: "cms",
			entities: { ContentType, Entry },
			repositories: { Types, Entries },
			exceptions: { Locked },
			commands: { Cms },
		});
		const described = App.describe().useCases.UpdateEntry;
		expect(described?.generic?.options).toEqual({
			dependencies: { types: "Types", logger: "Logger" },
			throws: ["Locked"],
			before: { kind: "opaque" },
			after: { kind: "opaque" },
		});
		expect(described?.errors).toEqual([
			{ kind: "core", name: "UseCaseEntityNotFound" },
			{ kind: "exception", ref: "Locked" },
		]);
		expect(described?.implementation).toMatchObject({
			kind: "steps",
			steps: [
				{ find: "repository.findById" },
				{ ensure: "exists" },
				{
					run: "before",
					fn: { kind: "opaque" },
					args: ["$input", "$item"],
					as: "prepared",
				},
				{ change: "$item", key: "title", value: "$prepared.title" },
				{ change: "$item", key: "locked", value: "$prepared.locked" },
				{ update: "repository" },
				{ run: "after", args: ["$saved", "$prepared"] },
				{ return: { item: "$saved" } },
			],
		});
	});

	test("the options are checked", () => {
		const { Types, Entries } = domain();
		const make = (options: object) => () =>
			StdUseCases.context.create(Entries, options as never);
		expect(make({ before: 1 })).toThrow("the option before must be a function");
		expect(make({ throws: [Error] })).toThrow(
			"the option throws must be a list of classes made by exceptionOf",
		);
		expect(make({ dependencies: { repository: Types } })).toThrow(
			"dependencies.repository is a name the use case gives its own dependency",
		);
		expect(() =>
			// @ts-expect-error: get does not write, so it takes no hooks
			StdUseCases.context.get(Entries, { before: () => {} }),
		).toThrow('it has no option "before"');
		expect(() =>
			// @ts-expect-error: nor does list
			StdUseCases.context.list(Entries, { after: () => {} }),
		).toThrow('it has no option "after"');
	});
});
