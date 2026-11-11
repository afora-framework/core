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

// A hand-written class may say again, with the decorators, what its
// generated base already carries from the spec.
const FIND_TS = `import { Access, Route } from "@afora/core";
import { FindNoteBase } from "../domain/use-cases";

@Route("GET", "/notes/{id}", { headers: { locale: "accept-language" } })
@Access({ scopes: ["notes:read"], context: { userId: "subject" } })
export class FindNote extends FindNoteBase {
	override async execute() {
		return { id: this.input.id, locale: this.input.locale };
	}
}
`;
const EXTRA = { "src/handlers/find-note.ts": FIND_TS };
const IMPORTS = { "useCases.FindNote": "../handlers/find-note#FindNote" };

const notes: Spec = {
	version: 1,
	name: "notes",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		Note: { fields: { title: "text", ownerId: "string" } },
		User: {
			fields: { name: "text", roles: "string[]" },
			plugins: ["authenticatable"],
		},
	},
	repositories: {
		Notes: {
			entity: "Note",
			actions: ["findById", "findPage", "create", "delete"],
		},
		Users: { entity: "User", actions: ["findById", "findByEmail", "create"] },
	},
	useCases: {
		CreateNote: {
			route: { method: "post", path: "/notes", status: 201 },
			access: { owner: { input: "ownerId" } },
			input: { fields: { title: "text", ownerId: "string" } },
			response: { fields: { note: "Note" } },
			dependencies: { notes: "Notes" },
			implementation: {
				steps: [
					{ create: "notes", value: "$input", as: "note" },
					{ return: { note: "$note" } },
				],
			},
		},
		FindNote: {
			route: {
				method: "get",
				path: "/notes/{id}",
				headers: { locale: "accept-language" },
			},
			access: { scopes: ["notes:read"], context: { userId: "subject" } },
			input: { fields: { id: "string", locale: "string?" } },
			response: { fields: { id: "string", locale: "string?" } },
			context: { fields: { userId: "string" } },
			implementation: { import: "../handlers/find-note#FindNote" },
		},
		RemoveNote: {
			generic: "delete",
			repository: "Notes",
			route: { method: "delete", path: "/notes/{id}", status: 204 },
			access: { scopes: ["notes:write"] },
		},
		Login: {
			generic: "login",
			repository: "Users",
			options: {
				as: "user",
				token: {
					secret: { env: "NOTES_JWT_SECRET" },
					refresh: { expiresIn: 3600 },
					scopesFrom: "roles",
				},
			},
			route: {
				method: "post",
				path: "/login",
				setCookie: { token: { name: "sid" } },
			},
			access: { public: true },
		},
	},
	commands: {
		Api: {
			useCases: {
				create: "CreateNote",
				find: "FindNote",
				remove: "RemoveNote",
				login: "Login",
			},
		},
	},
};

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));
const codes = (spec: unknown) =>
	validateSpec(spec as Spec).map(
		({ path, code }) => `${path.join(".")}: ${code}`,
	);
// biome-ignore lint/suspicious/noExplicitAny: a spec edited into an invalid one
const edited = (edit: (spec: any) => void) => {
	const copy = JSON.parse(JSON.stringify(notes));
	edit(copy);
	return copy;
};

describe("route and access in a spec", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(notes)).toEqual([]);
		expect(Value.Check(specSchema, notes)).toBe(true);
	});

	test("a route must fit the input and the response", () => {
		expect(
			codes(edited((s) => (s.useCases.CreateNote.route.method = "head"))),
		).toEqual(["useCases.CreateNote.route.method: invalid_route"]);
		expect(
			codes(
				edited((s) => (s.useCases.CreateNote.route.path = "/notes/{nope}")),
			),
		).toEqual(["useCases.CreateNote.route.path: invalid_route"]);
		expect(
			codes(edited((s) => (s.useCases.CreateNote.route.path = "/notes/:id"))),
		).toEqual(["useCases.CreateNote.route.path: invalid_route"]);
		expect(
			codes(
				edited((s) => {
					s.useCases.CreateNote.route.path = "/notes/{title}";
					s.useCases.CreateNote.route.query = ["title"];
				}),
			),
		).toEqual(["useCases.CreateNote.route.query.0: invalid_route"]);
		expect(
			codes(edited((s) => (s.useCases.CreateNote.route.status = 500))),
		).toEqual(["useCases.CreateNote.route.status: invalid_route"]);
		expect(
			codes(
				edited(
					(s) =>
						(s.useCases.CreateNote.route.setCookie = { nope: { name: "c" } }),
				),
			),
		).toEqual(["useCases.CreateNote.route.setCookie.nope: invalid_route"]);
		expect(
			codes(edited((s) => (s.useCases.CreateNote.route.verb = "x"))),
		).toEqual(["useCases.CreateNote.route.verb: unknown_key"]);
		// A standard use case: the shape is checked, the keys by the generated code.
		expect(
			codes(edited((s) => (s.useCases.RemoveNote.route = { method: "nope" }))),
		).toEqual(["useCases.RemoveNote.route.method: invalid_route"]);
	});

	test("an access must fit the input and the context", () => {
		expect(
			codes(
				edited(
					(s) => (s.useCases.CreateNote.access = { owner: { input: "nope" } }),
				),
			),
		).toEqual(["useCases.CreateNote.access.owner.input: invalid_access"]);
		expect(
			codes(
				edited(
					(s) =>
						(s.useCases.CreateNote.access = { context: { userId: "subject" } }),
				),
			),
		).toEqual(["useCases.CreateNote.access.context.userId: invalid_access"]);
		expect(
			codes(
				edited(
					(s) => (s.useCases.FindNote.access = { context: { userId: "name" } }),
				),
			),
		).toEqual(["useCases.FindNote.access.context.userId: invalid_access"]);
		expect(
			codes(
				edited(
					(s) => (s.useCases.FindNote.access = { public: true, scopes: ["a"] }),
				),
			),
		).toEqual(["useCases.FindNote.access: invalid_access"]);
		expect(
			codes(edited((s) => (s.useCases.FindNote.access = { role: "admin" }))),
		).toEqual(["useCases.FindNote.access.role: unknown_key"]);
	});

	test("generates the settings, and a standard use case takes them as options", () => {
		const files = Object.fromEntries(
			generate(notes).map((file) => [file.path, file.contents]),
		);
		const useCases = files["src/domain/use-cases.ts"] as string;
		expect(useCases).toContain(
			'route: { method: "post", path: "/notes", status: 201 }',
		);
		expect(useCases).toContain('access: { owner: { input: "ownerId" } }');
		expect(useCases).toContain(
			'route: { method: "delete", path: "/notes/{id}", status: 204 }',
		);
		expect(useCases).toContain('secret: { env: "NOTES_JWT_SECRET" }');
		expect(useCases).not.toContain("@Route");
	});

	test("JSON -> generate -> run -> extract keeps routes and access", async () => {
		const dir = await makeProject(generate(notes), EXTRA);
		projects.push(dir);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		const domain = await import(join(dir, "src/domain/index.ts"));
		const { useCases } = domain.App;
		expect(useCases.CreateNote.route).toEqual({
			method: "post",
			path: "/notes",
			status: 201,
		});
		expect(useCases.FindNote.access).toEqual({
			scopes: ["notes:read"],
			context: { userId: "subject" },
		});
		expect(useCases.RemoveNote.route.status).toBe(204);
		expect(useCases.Login.access).toEqual({ public: true });
		expect(Object.keys(useCases.Login.response.properties)).toEqual([
			"user",
			"token",
			"refreshToken",
		]);
		expect(canonical(extractSpec(domain.App, { imports: IMPORTS }))).toEqual(
			canonical(notes),
		);
	});
});
