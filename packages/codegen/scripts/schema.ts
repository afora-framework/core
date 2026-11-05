/** Writes afora.schema.json, the JSON Schema of the spec, for editors (`$schema`) and tools. */
import { specSchema } from "../src/spec/schema";

const schema = {
	$schema: "http://json-schema.org/draft-07/schema#",
	...JSON.parse(JSON.stringify(specSchema)),
};
await Bun.write(
	new URL("../afora.schema.json", import.meta.url),
	`${JSON.stringify(schema, null, "\t")}\n`,
);
