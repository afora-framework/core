/** Puts a new lesson at the end of its module: the caller does not choose the position. */
export async function place({
	input,
	dependencies,
}: {
	input: {
		readonly moduleId: string;
		readonly title: string;
		readonly status: "draft" | "published";
	};
	dependencies: {
		lessons: {
			count(options: { where: { moduleId: string } }): Promise<number>;
		};
	};
}) {
	const position = await dependencies.lessons.count({
		where: { moduleId: input.moduleId },
	});
	return { ...input, position };
}
