// The flat validator alone, for the bundle size and cold start of Typia (see ../../entries/typia.ts).
import typia, { type tags } from "typia";

type Flat = {
	name: string & tags.MinLength<3>;
	email: string & tags.Format<"email">;
	age: number & tags.Type<"int32"> & tags.Minimum<0>;
};

export const flat = typia.createValidateEquals<Flat>();
