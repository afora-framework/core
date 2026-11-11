# Pagination with a cursor

You list a collection that grows while people read it, and `offset` repeats or skips rows, or gets slow far into the list.

```ts
import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

export class Entry extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
) {}

export const Entries = repositoryOf({
	entity: Entry,
	actions: ["create", "findCursor"],
});

// Each page gives `next`, the `after` of the following one; undefined on the last.
export async function allTitles(limit: number): Promise<string[]> {
	const titles: string[] = [];
	let after: string | undefined;
	do {
		const page = await Entries.findCursor({
			orderBy: [{ key: "title" }],
			limit,
			after,
		});
		titles.push(...page.items.map((entry) => entry.title));
		after = page.next;
	} while (after !== undefined);
	return titles;
}
```

`findCursor` pages by position. A page is `{ items, limit, next }`, and `next` is the `after` of the following page; the last page has no `next`. The `id` is added as the last order, so a row has one position even when the keys you order by tie. A row added or removed between two pages never repeats or skips another.

Keep `where`, `orderBy` and `limit` the same from one page to the next. The cursor is opaque text but not encrypted: it holds the values of the order keys of the last row, so a key in `options.sensitive` cannot order one. An `after` made for another `orderBy` throws `InvalidRepositoryCursor`, which an output answers with 400. The provider must read by cursor (`capabilities.keyset`); `inMemoryProvider()` does.

To do something with every page (a bulk rewrite, a delete), use `forEachPage` instead of the loop.

More: [Repositories](../repositories.md#repositories) (cursors, `forEachPage`), [Troubleshooting](../troubleshooting.md).
