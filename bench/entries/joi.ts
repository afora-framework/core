import Joi from "joi";
import { raw } from "./input.ts";

const Flat = Joi.object({
	name: Joi.string().trim().min(3).required(),
	email: Joi.string().trim().lowercase().email({ tlds: false }).required(),
	age: Joi.number().integer().min(0).required(),
});

export const result = Flat.validate(raw, { abortEarly: false });
