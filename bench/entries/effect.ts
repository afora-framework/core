import * as S from "effect/Schema";
import * as T from "effect/SchemaTransformation";
import { raw } from "./input.ts";

const trimmed = S.String.pipe(S.decodeTo(S.String, T.trim()));
const Flat = S.Struct({
	name: trimmed.pipe(S.decodeTo(S.String.check(S.isMinLength(3)))),
	email: trimmed.pipe(
		S.decodeTo(S.String, T.toLowerCase()),
		S.decodeTo(S.String.check(S.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/))),
	),
	age: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});

export const result = S.decodeUnknownResult(Flat)(raw, {
	errors: "all",
	onExcessProperty: "error",
});
