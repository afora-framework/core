import { describe, expect, test } from "bun:test";
import { propertyLineageOf } from "../../core/property/lineage";
import { enumOf } from "./enum";

describe("enumOf", () => {
	test("records a default that is the first value, as given", () => {
		const given = propertyLineageOf(enumOf(["a", "b"], { default: "a" }));
		expect(given).toMatchObject({ args: { default: "a" } });
		const omitted = propertyLineageOf(enumOf(["a", "b"]));
		expect(omitted).not.toHaveProperty("args.default");
	});
});
