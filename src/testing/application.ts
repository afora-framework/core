import {
	applicationOf,
	isApplication,
	TestApplicationKey,
	type TestApplicationSettings,
} from "../core/application/application";
import { InvalidApplicationDeclaration } from "../core/application/exceptions";
import type { AnyApplication } from "../core/application/types/application.interface";
import {
	type InMemoryProvider,
	inMemoryProvider,
} from "../core/repository/in-memory";
import type { IRepositoryProvider } from "../core/repository/types/repository.interface";
import type { RuntimeServices } from "../core/runtime-scope";

/** The options of `testApplicationOf`. */
export interface TestApplicationOptions<
	App extends AnyApplication,
	Provider extends IRepositoryProvider = InMemoryProvider,
> {
	/**
	 * What every repository of the application reads and writes through,
	 * whatever provider it declares; a new `inMemoryProvider()` by default.
	 */
	readonly provider?: Provider;
	/** The runtime services of the application, over those of `app` (see `applicationOf`). */
	readonly runtime?: RuntimeServices;
	/** Inserts the fixtures, through `app.repositories` or `app.run`, once it has started. */
	readonly seed?: (app: TestApplication<App, Provider>) => unknown;
	/**
	 * While it runs, a write through a repository no application bound (one
	 * the application does not register, called at module level) throws
	 * `RepositoryWrittenOutsideApplication`. Process-wide. `false` by default.
	 */
	readonly strict?: boolean;
}

/** `Symbol.asyncDispose` where the `lib` of the project declares it. */
type AsyncDisposeKey = SymbolConstructor extends {
	readonly asyncDispose: infer Key extends symbol;
}
	? Key
	: never;

/**
 * An application of `testApplicationOf`: `app` reading and writing
 * through its own `provider`, which `await using` stops.
 */
export type TestApplication<
	App extends AnyApplication,
	Provider extends IRepositoryProvider = InMemoryProvider,
> = App & { readonly provider: Provider } & {
	readonly [Key in AsyncDisposeKey]: () => Promise<void>;
};

const invalid = (reason: string): never => {
	throw new InvalidApplicationDeclaration({
		source: "testApplicationOf",
		details: { reason },
	});
};

/**
 * An application for one test: it extends `app` (its declarations, log,
 * services, publishers, runtime and `app.with` replacements) with every
 * repository reading and writing through a new `inMemoryProvider()` (or
 * `options.provider`): the default provider, those of `providersOf` and
 * those repositories declare alike, so no row is shared with another test.
 * It is started without becoming the application of the process
 * (`useApplication`), so tests can run at once, `options.seed` has run,
 * and `Symbol.asyncDispose` stops it, also when the test throws.
 *
 * @example
 * import { applicationOf, blueprintOf, entityOf, repositoryOf } from "@afora/core";
 * import { testApplicationOf } from "@afora/core/testing";
 *
 * class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
 * const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });
 * const App = applicationOf({ name: "notes", entities: { Note }, repositories: { Notes } });
 *
 * // In a test: stopped when the block ends, also when it throws.
 * await using app = await testApplicationOf(App, {
 * 	seed: (app) => app.repositories.Notes.create(new Note({ title: "a" })),
 * });
 * await app.repositories.Notes.count(); // 1, in this application only
 * await app.provider.clear(); // empties it, if the test needs to
 * @throws {@link InvalidApplicationDeclaration} when `app` is not an application or an option is not of its kind.
 */
export async function testApplicationOf<
	App extends AnyApplication,
	Provider extends IRepositoryProvider = InMemoryProvider,
>(
	app: App,
	options: TestApplicationOptions<App, Provider> = {},
): Promise<TestApplication<App, Provider>> {
	if (!isApplication(app)) invalid("Expected an application of applicationOf.");
	if (typeof options !== "object" || options === null) {
		invalid("Expected the options to be an object.");
	}
	const { provider, runtime, seed, strict = false } = options;
	if (
		provider !== undefined &&
		(typeof provider !== "object" || provider === null)
	) {
		invalid("Expected provider to be a repository provider.");
	}
	if (seed !== undefined && typeof seed !== "function") {
		invalid("Expected seed to be a function of the application.");
	}
	if (typeof strict !== "boolean") invalid("Expected strict to be a boolean.");
	const test: TestApplicationSettings = {
		provider: provider ?? inMemoryProvider(),
		strict,
	};
	const application = applicationOf({
		name: app.name,
		extends: [app],
		...(runtime === undefined ? {} : { runtime }),
		[TestApplicationKey]: test,
	} as never) as unknown as TestApplication<App, Provider>;
	await application.start({ register: false });
	try {
		await seed?.(application);
	} catch (error) {
		await application.stop();
		throw error;
	}
	return application;
}
