import { isBlueprint } from "../blueprint/is-blueprint";
import type {
	AnyBlueprint,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";
import { isProperty } from "../property/is-property";
import { Kind } from "../symbols/kind";

/** Where an environment reads its variables from; `process.env` by default. */
export type EnvironmentSource = () => Readonly<
	Record<string, string | undefined>
>;

/** What `environmentOf` takes, after the blueprint. */
export interface EnvironmentOptions {
	/**
	 * The variables to read, e.g. `() => Bun.env`.
	 *
	 * @default `() => process.env`
	 */
	readonly source?: EnvironmentSource;
}

/**
 * The variables of the environment a blueprint describes, e.g.
 * `{ DATABASE_URL: ctx.url, PORT: ctx.integer }`, read, converted and
 * validated on the first `load`.
 */
export interface IEnvironment<Properties extends IBlueprintCollection> {
	readonly [Kind]: "environment";
	readonly blueprint: IBlueprint<Properties>;
	/**
	 * The validated variables, read on the first call and the same after.
	 *
	 * @throws {@link InvalidEnvironment} when a variable is missing or rejected.
	 */
	load(): Readonly<BlueprintValue<Properties>>;
}

/** Any environment, whatever its blueprint. */
// biome-ignore lint/suspicious/noExplicitAny: any environment, whatever its blueprint
export type AnyEnvironment = IEnvironment<any>;

/** The variables of `Environment`, once validated. */
export type EnvironmentValue<Environment extends AnyEnvironment> = ReturnType<
	Environment["load"]
>;

/** One environment, or a list of them, whose variables are merged in order. */
export type EnvironmentDependencies =
	| AnyEnvironment
	| readonly AnyEnvironment[];

/**
 * The variables of every environment of `Dependencies`, merged.
 * @internal
 */
export type MergedEnvironment<
	Dependencies extends EnvironmentDependencies | undefined,
> = Dependencies extends AnyEnvironment
	? EnvironmentValue<Dependencies>
	: Dependencies extends readonly AnyEnvironment[]
		? UnionToIntersection<EnvironmentValue<Dependencies[number]>> &
				Readonly<Record<never, never>>
		: Readonly<Record<never, never>>;

type UnionToIntersection<Union> = (
	Union extends unknown
		? (value: Union) => void
		: never
) extends (value: infer Intersection) => void
	? Intersection
	: never;

/** A variable of the environment is missing or rejected by its blueprint. */
export const InvalidEnvironment = exceptionOf({
	layer: ExceptionLayers.Environment,
	name: "InvalidEnvironment",
	message: ({ keys }: { readonly keys: readonly string[] }) =>
		`Invalid environment variables: ${keys.join(", ")}.`,
});

const processEnv: EnvironmentSource = () =>
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env ?? {};

/**
 * The environment `blueprint` describes: `load` reads the declared variables
 * from `options.source` (`process.env` by default), converts each to a
 * boolean (`"true"`, `"false"`) or a number when its property takes one
 * instead of a string, validates them once and
 * gives the same value after. As a dependency of a repository it reaches the
 * provider as `context.env`; of a use case ({@link useCaseOf}), the use case gets its value, e.g.
 * `environmentOf(blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })))`.
 *
 * @throws {TypeError} when `blueprint` is not a blueprint, or is an optional one.
 *
 * @example
 * ```ts
 * import { blueprintOf, environmentOf } from "@afora/core";
 *
 * const Env = environmentOf(
 * 	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url, PORT: ctx.integer })),
 * 	{ source: () => ({ DATABASE_URL: "https://db.example.com", PORT: "3000" }) },
 * );
 *
 * Env.load().PORT; // 3000, converted from the string
 * // Env.load() throws InvalidEnvironment when a variable is missing or invalid
 * ```
 */
export function environmentOf<Properties extends IBlueprintCollection>(
	blueprint: IBlueprint<Properties, boolean>,
	{ source = processEnv }: EnvironmentOptions = {},
): IEnvironment<Properties> {
	if (!isBlueprint(blueprint) || blueprint.optional) {
		throw new TypeError("An environment requires a blueprint");
	}
	let value: Readonly<BlueprintValue<Properties>> | undefined;

	return Object.freeze({
		[Kind]: "environment" as const,
		blueprint: blueprint as IBlueprint<Properties>,
		load(): Readonly<BlueprintValue<Properties>> {
			if (value !== undefined) return value;
			value = parseEnvironment(blueprint, source()) as Readonly<
				BlueprintValue<Properties>
			>;
			return value;
		},
	});
}

/** The declared variables of `variables`, validated by `blueprint`. */
function parseEnvironment(
	blueprint: AnyBlueprint,
	variables: Readonly<Record<string, string | undefined>>,
): unknown {
	const declared: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(blueprint.properties)) {
		const variable = variables[key];
		if (variable !== undefined) declared[key] = convert(field, variable);
	}
	const parsed = blueprint.safeParse(declared);
	if (!parsed.issues) return Object.freeze(parsed.value);

	const issues: readonly Issue[] = parsed.issues;
	throw new InvalidEnvironment({
		source: "environment",
		details: {
			keys: [...new Set(issues.map((issue) => String(issue.path[0] ?? "")))],
		},
		cause: issues.find((issue) => issue.cause)?.cause,
	});
}

/**
 * `variable` as the property `field` takes it: as is when the property takes
 * a string, otherwise `true` or `false`, or a number, when the property takes
 * that type. Any other value is kept, for the blueprint to reject.
 */
function convert(field: unknown, variable: string): unknown {
	if (!isProperty(field)) return variable;
	const { schema } = field.type;
	if (schema.matchShape(variable)) return variable;
	const text = variable.trim();
	if (text === "true" || text === "false") {
		if (schema.matchShape(text === "true")) return text === "true";
	}
	const number = text === "" ? Number.NaN : Number(text);
	if (Number.isFinite(number) && schema.matchShape(number)) return number;
	return variable;
}

/** The variables of every environment of `dependencies`, merged in order. */
export function loadEnvironments(
	dependencies: EnvironmentDependencies | undefined,
): Readonly<Record<string, unknown>> {
	if (dependencies === undefined) return Object.freeze({});
	const list = isEnvironment(dependencies) ? [dependencies] : dependencies;
	return Object.freeze(
		Object.assign({}, ...list.map((environment) => environment.load())),
	);
}

/** Whether `value` is an environment made by `environmentOf`. */
export function isEnvironment(value: unknown): value is AnyEnvironment {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "environment"
	);
}
