import { describe, expect, test } from "bun:test";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import { problemOf } from "./problem";
import { statusOf } from "./status";

const RenderedOutsideProvider = exceptionOf({
	layer: ExceptionLayers.Interface,
	name: "RenderedOutsideProvider",
	message: "A hook was used outside its provider.",
});

describe("an exception of the Interface layer", () => {
	test("has its own layer value", () => {
		expect(String(ExceptionLayers.Interface)).toBe("interface");
		expect(new RenderedOutsideProvider({ source: "Page" }).layer).toBe(
			ExceptionLayers.Interface,
		);
	});

	test("is a 500 unless a status, an operation or its issues say otherwise", () => {
		const error = new RenderedOutsideProvider({ source: "Page" });
		expect(statusOf(error)).toBe(500);
		expect(statusOf(error, undefined, { RenderedOutsideProvider: 400 })).toBe(
			400,
		);
		expect(statusOf(error, { errors: [RenderedOutsideProvider] })).toBe(422);
	});

	test("keeps its layer in the problem and is told apart from Output", () => {
		const error = new RenderedOutsideProvider({ source: "Page" });
		expect(error.passedThrough(ExceptionLayers.Output)).toBe(false);
		expect(problemOf(error, { status: 500 }).title).toBe(
			"RenderedOutsideProvider",
		);
	});
});
