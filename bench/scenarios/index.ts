// The scenarios, in the order they are reported. A scenario is a function from
// the afora module to its inputs and contenders, one file per shape.
import type { Scenario } from "../contenders.ts";
import { apiPayload } from "./api-payload.ts";
import { deep } from "./deep.ts";
import { flat, noTransform } from "./flat.ts";
import { largeList } from "./large-list.ts";
import { nested } from "./nested.ts";
import { union } from "./union.ts";

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const scenarioBuilders: Array<(afora: any) => Scenario> = [
	flat,
	nested,
	apiPayload,
	largeList,
	union,
	deep,
	noTransform,
];
