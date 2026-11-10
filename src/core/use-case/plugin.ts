import { hasPlugin, isVersion } from "../record/plugin";
import { isRepository } from "../repository/repository";
import { inspectRepository } from "../repository/state";
import type { AnyRepository } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { InvalidUseCasePlugin, UseCaseUnavailable } from "./exceptions";
import { isPlain } from "./steps/references";
import { useCaseTargetOf } from "./target";
import type {
	AnyUseCasePlugin,
	IUseCasePlugin,
	UseCaseMaker,
	UseCaseOriginInfo,
	UseCasePluginSettings,
} from "./types/plugin.interface";
import { type AnyUseCaseClass, useCaseOf } from "./use-case";

/** Where the origin of a use case class made by a plugin is kept; inherited by the classes extending it. */
const UseCaseOrigin = Symbol("useCaseOrigin");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Numbers given to the classes and functions among options, to tell two options apart. */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** A text equal for equal options: keys in order, classes and functions by identity. */
function keyOf(value: unknown): string {
	if (typeof value === "function" || (typeof value === "object" && value)) {
		if (Array.isArray(value)) return `[${value.map(keyOf).join(",")}]`;
		if (isPlain(value)) {
			return `{${Object.keys(value)
				.sort()
				.filter((key) => value[key] !== undefined)
				.map((key) => `${JSON.stringify(key)}:${keyOf(value[key])}`)
				.join(",")}}`;
		}
		let identity = identities.get(value);
		if (identity === undefined) {
			identity = nextIdentity++;
			identities.set(value, identity);
		}
		return `#${identity}`;
	}
	return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Whether `value` is a plugin made by `useCasePluginOf`. */
export function isUseCasePlugin(value: unknown): value is AnyUseCasePlugin {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "use-case-plugin"
	);
}

/**
 * The plugin, the repository and the options a use case class was made
 * from, by a plugin's `make`; `undefined` for a class declared by hand. A
 * class extending one keeps its origin.
 */
export function useCaseOriginOf(
	UseCase: unknown,
): UseCaseOriginInfo | undefined {
	return typeof UseCase === "function"
		? (UseCase as { readonly [UseCaseOrigin]?: UseCaseOriginInfo })[
				UseCaseOrigin
			]
		: undefined;
}

/**
 * A use case that is made for a repository. `settings.compile` gets what is
 * known of the repository and its entity (`UseCaseTargetInfo`) and the
 * options of the call, and gives the settings of `useCaseOf` with `steps`;
 * `settings.requires` lists the actions and record plugins it cannot do
 * without. The plugin's `make(repository, options)` gives the class, the
 * same for the same repository and equal options.
 *
 * `Make` types that call: give it to say which repositories are accepted
 * (`UseCaseTarget`) and what the use case takes and returns. Without it any
 * repository is accepted and the class is `AnyUseCaseClass`.
 *
 * Throws `InvalidUseCasePlugin` for a name that is not an identifier, a
 * version that is not semantic or a `compile` that is not a function.
 */
export function useCasePluginOf<
	const Name extends string,
	Make extends UseCaseMaker = UseCaseMaker,
>(name: Name, settings: UseCasePluginSettings): IUseCasePlugin<Name, Make> {
	const source = typeof name === "string" ? name : "useCasePluginOf";
	const invalid = (reason: string): never => {
		throw new InvalidUseCasePlugin({ source, details: { reason } });
	};
	if (typeof name !== "string" || !NAME.test(name)) {
		invalid("its name must be an identifier");
	}
	if (!isPlain(settings) || typeof settings.compile !== "function") {
		invalid("it needs a compile function");
	}
	const { version = "1.0.0", description, compile } = settings;
	if (!isVersion(version)) {
		invalid(`"${String(version)}" is not a semantic version`);
	}
	if (description !== undefined && typeof description !== "string") {
		invalid("its description must be a string");
	}
	const names = (list: unknown, what: string): readonly string[] => {
		if (list === undefined) return Object.freeze([]);
		if (
			!Array.isArray(list) ||
			list.some((item) => typeof item !== "string" || item === "")
		) {
			invalid(`requires.${what} must be a list of names`);
		}
		return Object.freeze([...new Set(list as readonly string[])]);
	};
	if (settings.requires !== undefined && !isPlain(settings.requires)) {
		invalid("requires must be an object of actions and plugins");
	}
	const requires = Object.freeze({
		actions: names(settings.requires?.actions, "actions"),
		plugins: names(settings.requires?.plugins, "plugins"),
	});

	const made = new WeakMap<object, Map<string, AnyUseCaseClass>>();

	const make = (repository: unknown, given?: unknown): AnyUseCaseClass => {
		if (!isRepository(repository)) {
			return invalid("it makes a use case for a repository of repositoryOf");
		}
		if (given !== undefined && !isPlain(given)) {
			return invalid("its options must be a plain object");
		}
		const options = Object.freeze({ ...(given as object | undefined) });
		const info = inspectRepository(repository) as NonNullable<
			ReturnType<typeof inspectRepository>
		>;
		let classes = made.get(info.state);
		if (!classes) {
			classes = new Map();
			made.set(info.state, classes);
		}
		const key = keyOf(options);
		const known = classes.get(key);
		if (known) return known;

		const target = useCaseTargetOf(repository as AnyRepository, name);
		const missing = {
			actions: requires.actions.filter(
				(action) => !info.actions.includes(action),
			),
			plugins: requires.plugins.filter(
				(plugin) => !hasPlugin(info.entity, plugin),
			),
		};
		if (missing.actions.length > 0 || missing.plugins.length > 0) {
			const quoted = (list: readonly string[]) =>
				list.map((item) => `"${item}"`).join(", ");
			throw new UseCaseUnavailable({
				source: name,
				details: {
					repository: target.repositoryName,
					reason: [
						missing.actions.length > 0
							? `the repository lacks the action ${quoted(missing.actions)}`
							: undefined,
						missing.plugins.length > 0
							? `the entity lacks the plugin ${quoted(missing.plugins)}`
							: undefined,
					]
						.filter(Boolean)
						.join(" and "),
					missing,
				},
			});
		}
		const UseCase = useCaseOf(
			compile(target, options) as never,
		) as unknown as AnyUseCaseClass;
		Object.defineProperty(UseCase, UseCaseOrigin, {
			value: Object.freeze({
				plugin,
				repository: repository as AnyRepository,
				options,
			}),
		});
		classes.set(key, UseCase);
		return UseCase;
	};

	const plugin: IUseCasePlugin<Name, Make> = Object.freeze({
		[Kind]: "use-case-plugin" as const,
		name,
		version,
		...(description === undefined ? {} : { description }),
		requires,
		make: make as unknown as Make,
		toJSON: () => ({
			kind: "use-case-plugin" as const,
			name,
			version,
			...(description === undefined ? {} : { description }),
			requires,
		}),
	});
	return plugin;
}
