import { transformOf } from "./stage";

/** The options of `select`. */
export interface SelectOptions {
	/** Keep operations that have any of these tags. */
	tags?: string[];
	/** Keep only these operation ids, e.g. `"Users.register"`. */
	operations?: string[];
	/** Drop these operation ids. */
	exclude?: string[];
}

const LISTS = ["tags", "operations", "exclude"] as const;

/**
 * Keeps the operations that match every given option: `tags` (any of),
 * `operations` (ids to keep) and `exclude` (ids to drop).
 */
export const select = transformOf<SelectOptions>({
	name: "select",
	validate: (options) => {
		for (const key of Object.keys(options)) {
			if (!(LISTS as readonly string[]).includes(key)) {
				return `select has no option "${key}".`;
			}
		}
		for (const key of LISTS) {
			const list: unknown = options[key];
			if (
				list !== undefined &&
				(!Array.isArray(list) || list.some((item) => typeof item !== "string"))
			) {
				return `Expected select.${key} to be a list of strings.`;
			}
		}
		return undefined;
	},
	apply: (operation, { tags, operations, exclude }) => {
		if (tags && !tags.some((tag) => operation.tags.includes(tag))) return null;
		if (operations && !operations.includes(operation.id)) return null;
		if (exclude?.includes(operation.id)) return null;
		return operation;
	},
});
