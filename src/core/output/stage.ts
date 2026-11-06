import { frozenJson } from "../json";
import { Kind } from "../symbols/kind";
import { InvalidOutputStage } from "./exceptions";
import type {
	IStageCatalog,
	OperationDescriptor,
	SinkFactory,
	SinkSettings,
	SinkStage,
	Stage,
	StageContext,
	StageDescription,
	StageFactory,
	StageOptions,
	TransformFactory,
	TransformSettings,
	TransformStage,
} from "./types/output.interface";

const descriptions = new WeakMap<object, StageDescription>();
const factories = new WeakMap<
	object,
	{ readonly kind: "transform" | "sink"; readonly name: string }
>();
const opaque: StageDescription = Object.freeze({ kind: "opaque" });

function invalid(source: string, reason: string): never {
	throw new InvalidOutputStage({ source, details: { reason } });
}

/** The frozen JSON options of a stage named `name`. */
function optionsOf<Options extends object>(
	name: string,
	given: unknown,
	validate: ((options: Options) => string | undefined) | undefined,
): Options {
	const options = frozenJson(given ?? {}, "Stage options", (reason) =>
		invalid(name, reason),
	);
	if (
		options === null ||
		typeof options !== "object" ||
		Array.isArray(options)
	) {
		invalid(name, "Stage options must be an object.");
	}
	const reason = validate?.(options as Options);
	if (reason !== undefined) invalid(name, reason);
	return options as Options;
}

function checkName(source: string, name: unknown): void {
	if (typeof name !== "string" || !name.trim()) {
		invalid(source, "Expected the stage name to be a non-empty string.");
	}
}

/** A factory of transform stages: `select({ tags: ["public"] })`. */
export function transformOf<Options extends object = StageOptions>(
	settings: TransformSettings<Options>,
): TransformFactory<Options> {
	checkName("transformOf", settings?.name);
	if (typeof settings.apply !== "function") {
		invalid(settings.name, "Expected apply to be a function.");
	}
	const { name, apply, validate } = settings;
	const factory = (given?: Options): TransformStage<Options> => {
		const options = optionsOf(name, given, validate);
		const stage: TransformStage<Options> = Object.freeze({
			kind: "transform" as const,
			name,
			options,
			apply: (operation: OperationDescriptor, context: StageContext) =>
				apply(operation, options, context),
		});
		descriptions.set(
			stage,
			Object.freeze({
				kind: "transform" as const,
				name,
				options: options as StageOptions,
			}),
		);
		return stage;
	};
	factories.set(factory, { kind: "transform", name });
	return factory;
}

/** A factory of sink stages: `openapi({ info })`. */
export function sinkOf<Result, Options extends object = StageOptions>(
	settings: SinkSettings<Result, Options>,
): SinkFactory<Result, Options> {
	checkName("sinkOf", settings?.name);
	if (typeof settings.build !== "function") {
		invalid(settings.name, "Expected build to be a function.");
	}
	const { name, build, validate } = settings;
	const factory = (given?: Options): SinkStage<Result, Options> => {
		const options = optionsOf(name, given, validate);
		const stage: SinkStage<Result, Options> = Object.freeze({
			kind: "sink" as const,
			name,
			options,
			build: (
				operations: readonly OperationDescriptor[],
				context: StageContext,
			) => build(operations, options, context),
		});
		descriptions.set(
			stage,
			Object.freeze({
				kind: "sink" as const,
				name,
				options: options as StageOptions,
			}),
		);
		return stage;
	};
	factories.set(factory, { kind: "sink", name });
	return factory;
}

/**
 * What a stage is: its kind, name and JSON options when it came from a
 * factory, `{ kind: "opaque" }` otherwise (a hand-written stage needs an
 * import mapping to be extracted).
 */
export function stageDescriptionOf(stage: Stage): StageDescription {
	return descriptions.get(stage) ?? opaque;
}

/** Whether `value` is shaped as a stage (made by a factory or written by hand). */
export function isStage(value: unknown): value is Stage {
	if (typeof value !== "object" || value === null) return false;
	const { kind, apply, build } = value as Record<string, unknown>;
	return (
		(kind === "transform" && typeof apply === "function") ||
		(kind === "sink" && typeof build === "function")
	);
}

/**
 * A catalog of stage `factories`, by name: what resolves the name and
 * options of a JSON pipe back to a stage. Throws `InvalidOutputStage` for a
 * function that is not a factory or for two with the same name.
 */
export function stageCatalogOf<const Factories extends readonly StageFactory[]>(
	...stages: Factories
): IStageCatalog {
	const byName: Record<string, StageFactory> = {};
	for (const factory of stages) {
		const known = factories.get(factory);
		if (!known) {
			invalid(
				"catalog",
				"A catalog takes factories made by `transformOf` or `sinkOf`.",
			);
		}
		if (Object.hasOwn(byName, known.name)) {
			invalid(known.name, "The catalog has another stage with its name.");
		}
		byName[known.name] = factory;
	}
	return Object.freeze({
		[Kind]: "stage-catalog" as const,
		stages: Object.freeze(byName),
		list: Object.freeze([...stages]),
		resolve(name: string, options?: StageOptions): Stage {
			const factory = Object.hasOwn(byName, name) ? byName[name] : undefined;
			if (!factory) invalid("catalog", `Unknown stage "${name}".`);
			return (factory as (options?: StageOptions) => Stage)(options);
		},
	});
}
