import { type TOptional, type TString, Type } from "typebox";
import { type PropertyClass, propertyOf } from "../../core/property/property";

const DEMO_DATE_TIME = "2026-01-01T00:00:00.000Z";

/** A class declared with `dateTimeOf`. */
interface DateTimeClass<Optional extends boolean>
	extends PropertyClass<Optional extends true ? TOptional<TString> : TString> {
	/** An instance holding the current date and time. */
	now<Self>(this: new (value: string) => Self): Self;
}

/** A property holding an ISO 8601 date and time, with `now()`. */
function dateTimeOf<Optional extends boolean = false>({
	name,
	optional,
	default: _default,
}: {
	name: string;
	optional?: Optional;
	default?: string;
}): DateTimeClass<Optional> {
	return class extends propertyOf({
		name,
		schema: Type.String({ format: "date-time" }),
		optional,
		default: _default,
	}) {
		/** An instance holding the current date and time. */
		static now<Self>(this: new (value: string) => Self): Self {
			return new this(new Date().toISOString());
		}
	};
}

/** An ISO 8601 date and time, e.g. `2026-01-01T00:00:00.000Z`. */
export class DateTime extends dateTimeOf({
	name: "dateTime",
	default: DEMO_DATE_TIME,
}) {}

/** An ISO 8601 calendar date, e.g. `2026-01-01`. */
export const DateProperty = propertyOf({
	name: "date",
	schema: Type.String({ format: "date" }),
	default: "2026-01-01",
});

/** When a record was created. */
export class CreatedAt extends dateTimeOf({
	name: "createdAt",
	default: DEMO_DATE_TIME,
}) {}

/** When a record was last updated; absent until it is. */
export class UpdatedAt extends dateTimeOf({
	name: "updatedAt",
	optional: true,
	default: DEMO_DATE_TIME,
}) {}

/** When a record was soft-deleted; absent while it is not. */
export class DeletedAt extends dateTimeOf({
	name: "deletedAt",
	optional: true,
}) {}
