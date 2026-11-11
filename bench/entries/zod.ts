import { z } from "zod";
import { raw } from "./input.ts";

const Flat = z.strictObject({
	name: z.string().trim().min(3),
	email: z.string().trim().toLowerCase().email(),
	age: z.number().int().min(0),
});

export const result = Flat.safeParse(raw);
