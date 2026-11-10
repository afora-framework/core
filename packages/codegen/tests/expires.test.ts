import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	compactSpec,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

/** Audit events expire 400 days after they are created; windows at their `until`. */
const expiring: Spec = {
	version: 1,
	name: "expiring",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		AuditEvent: {
			fields: { action: "text" },
			expires: { after: { days: 400, hours: 6 } },
		},
		Window: {
			fields: { name: "text", until: "dateTime?" },
			expires: { at: "until" },
		},
	},
	repositories: {
		AuditEvents: {
			entity: "AuditEvent",
			actions: ["create", "findMany", "count"],
		},
		Windows: { entity: "Window", actions: ["create", "findMany"] },
	},
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(expiring));
	change(copy);
	return copy;
};

const codes = (spec: Spec) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

describe("expires: validation", () => {
	test("a valid spec has no issues and matches the JSON Schema", () => {
		expect(validateSpec(expiring)).toEqual([]);
		expect(Value.Check(specSchema, expiring)).toBe(true);
	});

	test("at must name a date field", () => {
		expect(
			codes(
				edit((c) => {
					c.entities.Window.expires = { at: "name" };
				}),
			),
		).toContain("invalid_expires@entities.Window.expires.at");
		expect(
			codes(
				edit((c) => {
					c.entities.Window.expires = { at: "missing" };
				}),
			),
		).toContain("invalid_expires@entities.Window.expires.at");
		expect(
			validateSpec(
				edit((c) => {
					c.entities.Window.fields.day = "date";
					c.entities.Window.expires = { at: "day" };
				}),
			),
		).toEqual([]);
	});

	test("after must be a non-empty duration of positive numbers", () => {
		const after = (value: unknown) =>
			codes(
				edit((c) => {
					c.entities.AuditEvent.expires = { after: value };
				}),
			);
		expect(after({})).toContain(
			"invalid_expires@entities.AuditEvent.expires.after",
		);
		expect(after({ days: 0 })).toContain(
			"invalid_expires@entities.AuditEvent.expires.after.days",
		);
		expect(after({ weeks: 1 })).toContain(
			"invalid_expires@entities.AuditEvent.expires.after.weeks",
		);
		expect(
			codes(
				edit((c) => {
					c.entities.AuditEvent.expires = { after: { days: 1 }, at: "x" };
				}),
			),
		).toContain("invalid_expires@entities.AuditEvent.expires");
	});

	test("with after, expiresAt is an identity key", () => {
		expect(
			codes(
				edit((c) => {
					c.entities.AuditEvent.fields.expiresAt = "dateTime";
				}),
			),
		).toContain("identity_key@entities.AuditEvent.fields.expiresAt");
	});

	test("records cannot expire", () => {
		expect(
			codes(
				edit((c) => {
					c.records = {
						Note: { fields: { body: "text" }, expires: { at: "body" } },
					};
				}),
			),
		).toContain("unknown_key@records.Note.expires");
	});
});

describe("expires: generation", () => {
	test("emits the option of entityOf", () => {
		const entities = generate(expiring).find((f) =>
			f.path.endsWith("entities.ts"),
		)?.contents as string;
		expect(entities).toContain("expires: { after: { days: 400, hours: 6 } }");
		expect(entities).toContain('expires: { at: "until" }');
	});
});

describe("expires: round trip", () => {
	// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
	type Any = any;

	test("JSON -> generate -> type-check -> run -> extract is equal", async () => {
		const dir = await makeProject(generate(expiring));
		projects.push(dir);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		const domain = (await import(join(dir, "src/domain/index.ts"))) as Any;
		const description = domain.App.describe();
		expect(description.entities.AuditEvent.expires).toEqual({
			after: { days: 400, hours: 6 },
		});
		expect(description.entities.Window.expires).toEqual({ at: "until" });
		// Bound by the application, the repository is reached through it.
		const AuditEvents = domain.App.repositories.AuditEvents;
		const created = await AuditEvents.create({ action: "login" });
		expect(typeof created.expiresAt).toBe("string");
		expect(await AuditEvents.count()).toBe(1);
		expect(canonical(extractSpec(domain.App))).toEqual(canonical(expiring));
	}, 120_000);
});
