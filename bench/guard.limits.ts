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
};

/**
 * The same for `Entity.safeParse` (a class extending `entityOf(...)`, which
 * also makes an id and a time stamp for a value that has none), as a multiple
 * of Zod 4 `safeParse` on the same case. Its own default, since it does more.
 */
export const ENTITY_DEFAULT = 2;

export const ENTITY_LIMITS: Record<string, { limit: number; why: string }> = {
	"flat valid": {
		limit: 2.2,
		why: "A valid entity makes a UUID v7 and a time stamp and keeps four more keys than the record (about 1.5x to 1.9x here); the limit is that plus noise.",
	},
	"no-transform valid": {
		limit: 2.6,
		why: "Zod 4 is at its fastest here (about 255 ns) while the entity pays a fixed cost for its identity and its four keys (about 2x); the limit is that plus noise.",
	},
	"no-transform invalid": {
		limit: 2.3,
		why: "A small object that fails: the cost is the exception-free rejection both pay, with the entity's four extra keys (about 1.6x).",
	},
};
