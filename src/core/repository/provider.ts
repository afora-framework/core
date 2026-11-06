import { InvalidRepositoryDeclaration } from "./exceptions";
import type {
	ProviderDescription,
	ProviderOption,
	ProviderOptions,
	ProviderSettings,
} from "./types/query.interface";
import type { IRepositoryProvider } from "./types/repository.interface";

const descriptions = new WeakMap<object, ProviderDescription>();
const opaque: ProviderDescription = Object.freeze({ kind: "opaque" });

function invalid(reason: string): never {
	throw new InvalidRepositoryDeclaration({
		source: "providerOf",
		details: { reason },
	});
}

function json(value: unknown, seen = new Set<object>()): ProviderOption {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || value === null || seen.has(value))
		return invalid("Provider options must be finite, acyclic JSON values.");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		return invalid(
			"Provider options must contain only plain objects and arrays.",
		);
	if (Object.getOwnPropertySymbols(value).length > 0)
		return invalid("Provider options cannot contain symbol keys.");
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => json(item, seen))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, json(item, seen)]),
			);
	seen.delete(value);
	return Object.freeze(result);
}

/** Creates a provider once and attaches an immutable, serializable declaration out of band. */
export function providerOf<
	Options extends ProviderOptions = ProviderOptions,
	Provider extends IRepositoryProvider = IRepositoryProvider,
>(settings: ProviderSettings<Options, Provider>): Provider {
	if (
		!settings ||
		typeof settings.name !== "string" ||
		settings.name.trim().length === 0 ||
		typeof settings.create !== "function"
	)
		invalid("Expected a provider name and create function.");
	const options = json(settings.options ?? {});
	if (options === null || typeof options !== "object" || Array.isArray(options))
		invalid("Provider options must be an object.");
	const provider = settings.create(options as Options);
	if (
		!provider ||
		typeof provider !== "object" ||
		["findOne", "findMany", "insert", "update", "remove", "count"].some(
			(key) =>
				typeof (provider as unknown as Record<string, unknown>)[key] !==
				"function",
		)
	)
		invalid("Expected a repository provider from create.");
	descriptions.set(
		provider,
		Object.freeze({
			kind: "provider",
			name: settings.name,
			options: options as ProviderOptions,
		}),
	);
	return provider;
}

/** Describes a named provider; an anonymous one needs an explicit import on extraction. */
export function providerDescriptionOf(
	provider: IRepositoryProvider,
): ProviderDescription {
	return descriptions.get(provider) ?? opaque;
}
