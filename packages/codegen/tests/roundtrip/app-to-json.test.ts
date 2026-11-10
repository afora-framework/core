import { afterAll, describe, expect, test } from "bun:test";
import { ExtractionError, extractSpec, validateSpec } from "../../src";
import { AccountsApp } from "./apps/accounts";
import { StorefrontApp } from "./apps/storefront";
import {
	ACCOUNTS_EXPECTED,
	accountsBehavior,
	STOREFRONT_EXPECTED,
	storefrontBehavior,
} from "./behaviors";
import { SHOP_OPTIONS } from "./fixtures/shop";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

const ACCOUNTS_IMPORTS = {
	Rating: "../support/rating",
	"useCases.Register.run.hashPassword": "../support/hash#hashPassword",
	"useCases.Login.run.verify": "../support/hash#verify",
	"useCases.Rate": "../handlers/rate#Rate",
	"useCases.Greet": "../handlers/greet#Greet",
	"repositories.Users.provider": "../support/anonymous-provider#anonymous",
	"commands.Notifier.events": "../support/events#dispatch",
	"commands.Alerts.onEventError": "../support/events#onError",
};

const ACCOUNTS_HANDLERS = {
	"src/handlers/rate.ts": `import { InvalidCredentials } from "../domain/exceptions";
import { RateBase } from "../domain/use-cases";

export class Rate extends RateBase {
	override async execute() {
		const user = await this.dependencies.users.findByEmail(this.input.email);
		if (!user) throw new InvalidCredentials({ source: "Rate" });
		user.change.name(\`\${user.name} (\${this.input.stars} stars)\`);
		return { user: await this.dependencies.users.update(user) };
	}
}
`,
	"src/handlers/greet.ts": `import { GreetBase } from "../domain/use-cases";

export class Greet extends GreetBase {
	override async execute() {
		return { greeting: \`Hello, \${this.input.name}!\` };
	}
}
`,
};

const STOREFRONT_IMPORTS = {
	"useCases.Sale.run.discounted": "../support/pricing#discounted",
	"useCases.Echo": "../handlers/echo#Echo",
	"outputs.Manual.pipe.0": "../support/stages#keepAll",
};

const STOREFRONT_HANDLERS = {
	"src/handlers/echo.ts": `import { EchoBase } from "../domain/use-cases";

export class Echo extends EchoBase {
	override async execute() {
		return { echo: [...this.input.text].reverse().join("") };
	}
}
`,
};

/** Extraction without `key` in the map throws an `ExtractionError` that names it. */
function expectEachKeyRequired(
	App: Any,
	imports: Record<string, string>,
	required: string[],
) {
	expect(() => extractSpec(App)).toThrow(ExtractionError);
	for (const key of required) {
		const { [key]: _, ...rest } = imports;
		let error: unknown;
		try {
			extractSpec(App, { imports: rest });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ExtractionError);
		expect((error as Error).message).toContain(`"${key}"`);
	}
}

describe("app -> JSON -> app: accounts", () => {
	test("the original behaves", async () => {
		expect(await accountsBehavior(AccountsApp)).toEqual(ACCOUNTS_EXPECTED);
	});

	test("what cannot be recreated comes out as import entries", () => {
		const spec = extractSpec(AccountsApp, { imports: ACCOUNTS_IMPORTS });
		expect(validateSpec(spec)).toEqual([]);
		expect(spec.properties?.Rating).toEqual({
			opaque: true,
			ref: "Rating",
			import: "../support/rating",
		});
		expect(spec.repositories?.Users?.provider).toEqual({
			import: "../support/anonymous-provider#anonymous",
		});
		expect(spec.useCases?.Greet?.implementation).toEqual({
			import: "../handlers/greet#Greet",
		});
		expect(spec.useCases?.Rate?.implementation).toEqual({
			import: "../handlers/rate#Rate",
		});
		const register = spec.useCases?.Register?.implementation as {
			steps: { run?: string; fn?: unknown }[];
		};
		expect(register.steps.find((step) => step.run)?.fn).toEqual({
			import: "../support/hash#hashPassword",
		});
		expect(spec.commands?.Notifier?.events).toEqual({
			import: "../support/events#dispatch",
		});
		expect(spec.commands?.Alerts?.onEventError).toEqual({
			import: "../support/events#onError",
		});
		// a function message cannot be recreated: it falls back to the default
		expect(spec.exceptions?.InvalidCredentials).toEqual({ layer: "use-case" });
	});

	test("extraction without the map throws an ExtractionError naming each key", () => {
		expectEachKeyRequired(
			AccountsApp,
			ACCOUNTS_IMPORTS,
			Object.keys(ACCOUNTS_IMPORTS).filter((key) => key !== "Rating"),
		);
	});

	test("an opaque property without a mapping is imported from ./opaque", () => {
		const { Rating: _, ...imports } = ACCOUNTS_IMPORTS;
		expect(extractSpec(AccountsApp, { imports }).properties?.Rating).toEqual({
			opaque: true,
			ref: "Rating",
			import: "./opaque",
		});
	});

	test("the generated application passes the same behavior and extracts to the same spec", async () => {
		const spec = extractSpec(AccountsApp, { imports: ACCOUNTS_IMPORTS });
		const project = await buildProject(
			[{ root: ".", spec }],
			{},
			ACCOUNTS_HANDLERS,
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await accountsBehavior(App)).toEqual(ACCOUNTS_EXPECTED);
		const again = extractSpec(App, { imports: ACCOUNTS_IMPORTS });
		expect(canonical(again)).toEqual(canonical(spec));
	}, 180_000);
});

describe("app -> JSON -> app: storefront", () => {
	test("the original behaves", async () => {
		expect(await storefrontBehavior(StorefrontApp)).toEqual(
			STOREFRONT_EXPECTED,
		);
	});

	test("what cannot be recreated comes out as import entries", () => {
		const spec = extractSpec(StorefrontApp, { imports: STOREFRONT_IMPORTS });
		expect(validateSpec(spec, {}, SHOP_OPTIONS)).toEqual([]);
		expect(spec.provider).toEqual({
			use: "memory",
			options: { label: "main" },
		});
		expect(spec.repositories?.Orders?.provider).toEqual({
			use: "memory",
			options: { label: "orders" },
		});
		expect(spec.repositories?.Products?.deletion).toBe("soft");
		expect(spec.useCases?.Echo?.implementation).toEqual({
			import: "../handlers/echo#Echo",
		});
		expect(spec.outputs?.Manual?.pipe).toEqual([
			{ import: "../support/stages#keepAll" },
		]);
		expect(spec.outputs?.Api?.pipe).toEqual([
			{ transform: "select", options: { tags: ["public"] } },
			{ transform: "label", options: { tag: "api" } },
			{
				sink: "openapi",
				options: { info: { title: "Storefront", version: "2.0.0" } },
			},
		]);
	});

	test("extraction without the map throws an ExtractionError naming each key", () => {
		expectEachKeyRequired(
			StorefrontApp,
			STOREFRONT_IMPORTS,
			Object.keys(STOREFRONT_IMPORTS),
		);
	});

	test("the generated application passes the same behavior and extracts to the same spec", async () => {
		const spec = extractSpec(StorefrontApp, { imports: STOREFRONT_IMPORTS });
		const project = await buildProject(
			[{ root: ".", spec }],
			SHOP_OPTIONS,
			STOREFRONT_HANDLERS,
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await storefrontBehavior(App)).toEqual(STOREFRONT_EXPECTED);
		const again = extractSpec(App, { imports: STOREFRONT_IMPORTS });
		expect(canonical(again)).toEqual(canonical(spec));
	}, 180_000);
});
