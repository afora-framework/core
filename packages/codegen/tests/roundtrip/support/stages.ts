import { type Stage, transformOf } from "@afora/core";

/** A catalog stage: { transform: "label", options: { tag } }. */
export const labeler = transformOf({
	name: "label",
	apply: (operation, options: { tag?: string }) => ({
		...operation,
		tags: [...operation.tags, options.tag ?? "labeled"],
	}),
});

/** A stage written by hand, so it is opaque. */
export const keepAll: Stage = {
	kind: "transform",
	apply: (operation) => operation,
};
