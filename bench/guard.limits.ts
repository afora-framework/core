// The most `blueprint.safeParse` may take in a case, as a multiple of Zod 4
// `safeParse` on the same case. A limit is where afora is, plus room for the
// noise of a shared CI runner; it is not room for a regression. It is only
// raised for a cost that is wanted, and the reason is written next to it.

/** For a case with no entry below: afora is at or below Zod 4, and 15% is noise. */
export const GUARD_DEFAULT = 1.15;

export const GUARD_LIMITS: Record<string, { limit: number; why: string }> = {
	"large-list valid": {
		limit: 1.25,
		why: "afora is level with Zod 4 here (about 1.0x): freezing 1,000 objects and their array is most of the time. The limit is that plus noise.",
	},
	"union invalid": {
		limit: 12,
		why: "A property whose schema is a union is explained by TypeBox `Errors`, which walks every variant again for each rejected value: about 9.4x Zod 4. Known and to be brought down; the limit only keeps it from getting worse.",
	},
};
