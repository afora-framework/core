import * as v from "valibot";
import { raw } from "./input.ts";

const Flat = v.strictObject({
	name: v.pipe(v.string(), v.trim(), v.minLength(3)),
	email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
	age: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const result = v.safeParse(Flat, raw);
