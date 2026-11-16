import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	eventOf,
	InvalidUseCaseDeclaration,
	listOf,
	optionalOf,
	type UseCaseResponse,
	useCaseOf,
} from "../../index";
import { parseResponse, responsePropertiesOf } from "./response";

const Summary = blueprintOf((ctx) => ({ title: ctx.string }));
const Empty = blueprintOf(() => ({}));
type SummaryValue = { title: string };

class Article extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {
	touch(): void {
		this.emit(Touched);
	}
}
const Touched = eventOf("article.touched", Article);

class Recent extends useCaseOf({
	name: "Recent",
	blueprint: blueprintOf((ctx) => ({ count: ctx.integer })),
	response: listOf(Summary, { maxItems: 3 }),
}) {
	override async execute() {
		return Array.from({ length: this.input.count }, (_, index) => ({
			title: `Article ${index}`,
		}));
	}
}

describe("a list as the response", () => {
	test("execute resolves with the frozen array of the items", async () => {
		const items = await new Recent({ count: 2 }).execute();
		expect(items).toEqual([{ title: "Article 0" }, { title: "Article 1" }]);
		expect(Array.isArray(items)).toBe(true);
		expect(Object.isFrozen(items)).toBe(true);
		expect(Object.isFrozen(items[0])).toBe(true);
		expect(Recent.response.item).toBe(Summary);
	});

	test("the type of the response is an array of the items", async () => {
		expectTypeOf<UseCaseResponse<typeof Recent>>().toEqualTypeOf<
			readonly SummaryValue[]
		>();
		const items = await new Recent({ count: 1 }).execute();
		// An override narrows the return type to what it returns.
		expectTypeOf(items).toMatchTypeOf<readonly SummaryValue[]>();
		const Records = useCaseOf({
			name: "Records",
			blueprint: Empty,
			response: listOf(Article),
			steps: [{ return: [] }],
		});
		expectTypeOf<UseCaseResponse<typeof Records>>().toEqualTypeOf<
			readonly Article[]
		>();
		expectTypeOf(await new Records({}).execute()).toEqualTypeOf<
			readonly Article[]
		>();
		// An object response keeps its type.
		const Single = useCaseOf({
			name: "Single",
			blueprint: Empty,
			response: Summary,
			steps: [{ return: { title: "a" } }],
		});
		expectTypeOf<UseCaseResponse<typeof Single>>().toEqualTypeOf<{
			title: string;
		}>();
	});

	test("an invalid item is an InvalidUseCaseResponse with its path", async () => {
		class Broken extends useCaseOf({
			name: "Broken",
			blueprint: Empty,
			response: listOf(Summary),
		}) {
			override async execute() {
				return [{ title: "ok" }, { title: 1 }] as never;
			}
		}
		const error = await new Broken({}).execute().catch((caught) => caught);
		expect(error.name).toBe("InvalidUseCaseResponse");
		expect(error.message).toMatch(/^Invalid UseCase response: "1\.title" /);
		expect(error.details.issues[0].path).toEqual([1, "title"]);
		const tooMany = await new Recent({ count: 4 })
			.execute()
			.catch((caught) => caught);
		expect(tooMany.name).toBe("InvalidUseCaseResponse");
		class NotAList extends useCaseOf({
			name: "NotAList",
			blueprint: Empty,
			response: listOf(Summary),
		}) {
			override async execute() {
				return { title: "a" } as never;
			}
		}
		await expect(new NotAList({}).execute()).rejects.toMatchObject({
			name: "InvalidUseCaseResponse",
		});
	});

	test("events of the entities in the list are collected", async () => {
		class Touch extends useCaseOf({
			name: "Touch",
			blueprint: Empty,
			response: listOf(Article),
		}) {
			override async execute() {
				return ["a", "b"].map((title) => {
					const article = new Article({ title });
					article.touch();
					return article;
				});
			}
		}
		const op = new Touch({});
		const articles = await op.execute();
		expect(articles[0]).toBeInstanceOf(Article);
		expect(op.pullEvents().map((event) => event.entity)).toEqual(articles);
	});

	test("a child use case can respond with a list", async () => {
		class Parent extends useCaseOf({
			name: "Parent",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { recent: Recent },
		}) {
			override async execute(deps = this.dependencies) {
				const items = await deps.recent({ count: 3 });
				expectTypeOf(items).toEqualTypeOf<readonly SummaryValue[]>();
				return { total: items.length };
			}
		}
		expect(await new Parent({}).execute()).toEqual({ total: 3 });
		await expect(
			new Parent({}).execute({
				recent: async () => [{ title: 2 }] as never,
			}),
		).rejects.toThrow(/^Invalid UseCase response: "0\.title" /);
	});

	test("a steps use case returns a list", async () => {
		const Echo = useCaseOf({
			name: "Echo",
			blueprint: blueprintOf(() => ({ items: listOf(Summary) })),
			response: listOf(Summary),
			steps: [{ return: "$input.items" }],
		});
		expect(await new Echo({ items: [{ title: "a" }] }).execute()).toEqual([
			{ title: "a" },
		]);
		const Strict = useCaseOf({
			name: "Strict",
			blueprint: blueprintOf(() => ({ items: listOf(Summary) })),
			response: listOf(Summary),
			strictSteps: true,
			steps: [{ return: "$input.items" }],
		});
		expect(await new Strict({ items: [] }).execute()).toEqual([]);
		useCaseOf({
			name: "StrictWrong",
			blueprint: blueprintOf((ctx) => ({ title: ctx.string })),
			response: listOf(Summary),
			strictSteps: true,
			// @ts-expect-error a string is not a list of summaries
			steps: [{ return: "$input.title" }],
		});
	});

	test("an optional list, or setCookie with a list, is rejected at declaration", () => {
		expect(() =>
			useCaseOf({
				name: "Optional",
				blueprint: Empty,
				response: optionalOf(listOf(Summary)) as never,
			}),
		).toThrow(InvalidUseCaseDeclaration);
		let reason: unknown;
		try {
			useCaseOf({
				name: "Cookies",
				blueprint: Empty,
				response: listOf(Summary),
				route: { method: "get", setCookie: { title: { name: "t" } } },
			});
		} catch (error) {
			reason = (error as { details: { reason: string } }).details.reason;
		}
		expect(reason).toBe(
			"route.setCookie sends response keys, and a list response has none: respond with a blueprint to set cookies.",
		);
	});

	test("parseResponse and responsePropertiesOf handle both kinds", () => {
		expect(parseResponse(listOf(Summary), [{ title: "a" }])).toEqual({
			value: [{ title: "a" }],
		});
		expect(parseResponse(Summary, { title: "a" })).toEqual({
			value: { title: "a" },
		});
		expect(responsePropertiesOf(listOf(Summary))).toBeUndefined();
		expect(responsePropertiesOf(Summary)).toBe(Summary.properties);
	});
});
