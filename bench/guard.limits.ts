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
		limit: 3.5,
		why: "Zod 4 is at its fastest here (250 to 400 ns) while the entity pays a fixed cost for its identity (two reads of the clock, a UUID v7) and its four keys, and that cost does not follow the speed of the CPU: on GitHub runners it is about 720-790 ns whether Zod 4 takes 255 ns or 330 ns, and about 1,000 ns where Zod 4 takes 400 ns. So the ratio depends on the kind of runner, each steady within a job: 2.1x-2.3x, 2.4x-2.65x and 2.75x-3.0x (nine jobs, November 2026; 2.1x-2.3x on an Apple M2). The limit is the highest, 3.0x, plus 15% for noise. What it lets through: a slowdown of up to 1.5x-1.6x on the runners at 2.1x-2.3x, 1.3x-1.45x at 2.4x-2.65x, 1.15x-1.25x at 2.75x-3.0x. Its ratio to `blueprint.safeParse` would not hold it closer, since the blueprint follows the CPU and the entity's identity does not (4.2x to 5.6x across the same runners), and nor would its ratio to `Record.safeParse` (2.5x to 2.8x).",
	},
	"no-transform invalid": {
		limit: 2.3,
		why: "A small object that fails: the cost is the exception-free rejection both pay, with the entity's four extra keys (about 1.6x).",
	},
};
