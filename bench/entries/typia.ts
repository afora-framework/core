import { flat } from "../typia/generated/flat-only.js";
import { clean } from "./input.ts";

export const result = flat(clean);
