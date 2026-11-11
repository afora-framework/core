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
