import { frozenJson } from "../json";
import { InvalidRepositoryDeclaration } from "./exceptions";
import type {
	ProviderDescription,
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

/** Creates a provider once and attaches an immutable, serializable declaration out of band. */
export function providerOf<
	Options extends ProviderOptions = ProviderOptions,
	const Provider extends IRepositoryProvider = IRepositoryProvider,
>(settings: ProviderSettings<Options, Provider>): Provider {
	if (
		!settings ||
		typeof settings.name !== "string" ||
		settings.name.trim().length === 0 ||
		typeof settings.create !== "function"
	)
		invalid("Expected a provider name and create function.");
	const options = frozenJson(
		settings.options ?? {},
		"Provider options",
		invalid,
	);
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
