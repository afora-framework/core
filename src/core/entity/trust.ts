/**
 * Under this key, the settings of an entity builder tell when what their
 * `generateId` and `now` make is known to be valid, so that an entity does
 * not check again the id and the date it has just made. Only for a builder
 * that knows its own makers, as `std` does of its defaults: a generator an
 * application configures is never vouched for.
 * @internal
 */
export const MakesValid = Symbol("makesValid");

/** @internal */
export interface ValidMakers {
	/** Whether the id `generateId` is about to make is one `id` accepts as it is. */
	readonly id: () => boolean;
	/** Whether the date `now` is about to make is one `createdAt` accepts as it is. */
	readonly createdAt: () => boolean;
}

/**
 * `settings` of an entity builder with `makers` vouching for its
 * `generateId` and `now`.
 * @internal
 */
export function vouching<const Settings extends object>(
	settings: Settings,
	makers: ValidMakers,
): Settings {
	return Object.defineProperty({ ...settings }, MakesValid, { value: makers });
}

/** The makers `settings` vouch for, if any. @internal */
export function validMakersOf(settings: object): ValidMakers | undefined {
	return (settings as { readonly [MakesValid]?: ValidMakers })[MakesValid];
}
