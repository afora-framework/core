import { type } from "arktype";
import { raw } from "./input.ts";

const Flat = type({
	name: type("string.trim").to("string >= 3"),
	email: type("string.trim")
		.pipe((value: string) => value.toLowerCase())
		.to("string.email"),
	age: "number.integer >= 0",
	"+": "reject",
});

export const result = Flat(raw);
