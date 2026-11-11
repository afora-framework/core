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
