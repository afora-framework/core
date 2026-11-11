# Soft delete and restore

You want `delete` to keep the row, so it can be listed for an audit or brought back, and to keep its unique values taken.

```ts
import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

export class Note extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ unique: ["title"] },
) {}

// "soft" keeps the row and sets deletedAt; "restore" is an action of its own
export const Notes = repositoryOf({
	entity: Note,
	actions: ["findById", "findMany", "create", "delete", "restore"],
	deletion: "soft",
});

export async function archiveAndBring(title: string) {
	const note = await Notes.create({ title });
	await Notes.delete(note);
	const hidden = await Notes.findById(note.id); // undefined: reads skip deleted rows
	const all = await Notes.findMany({ withDeleted: true }); // unless you ask
	const back = await Notes.restore(note.id); // a new, alive entity
	return { hidden, all, back };
}
```

`deletion: "soft"` makes `delete` store `deletedAt` through the provider's `update` instead of removing the row. Every read leaves the row out (`findById` gives `undefined`) unless the query has `withDeleted: true`. `restore` is an action of its own: it reads the row with deleted ones included, clears `deletedAt` and gives a new, live entity; the deleted instance you hold stays deleted, and a deleted entity no longer changes.

Two things to know. The unique values of a deleted row stay occupied, so a new note cannot reuse its title until the row is removed. And `restore` without `deletion: "soft"` throws `InvalidRepositoryDeclaration` when the repository is declared.

More: [Repositories](../repositories.md) (deletion, `restore`), [Entities](../entities.md) (`destroy()`, `isDeleted`), [Standard use cases](../std-use-cases.md).
