import { expect, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { coerceTextValues } from "./coerce";

const Query = blueprintOf((ctx) => ({
	page: ctx.integer,
	ratio: ctx.number,
	draft: ctx.boolean,
	title: ctx.string,
	limit: ctx.optional.integer,
}));

test("coerces text to the scalar each field takes", () => {
	expect(
		coerceTextValues(Query, {
			page: " 2 ",
			ratio: "0.5",
			draft: "true",
			title: "42",
			limit: undefined,
		}),
	).toEqual({ page: 2, ratio: 0.5, draft: true, title: "42" });
});

test("keeps invalid text and unknown keys for the blueprint to reject", () => {
	expect(
		coerceTextValues(Query, {
			page: "two",
			draft: "yes",
			ratio: "",
			other: "x",
		}),
	).toEqual({ page: "two", draft: "yes", ratio: "", other: "x" });
});
