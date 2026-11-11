import * as y from "yup";
import { raw } from "./input.ts";

const Flat = y
	.object({
		name: y.string().required().trim().min(3),
		email: y.string().required().trim().lowercase().email(),
		age: y.number().required().integer().min(0),
	})
	.exact();

export const result = Flat.validateSync(raw, { abortEarly: false });
