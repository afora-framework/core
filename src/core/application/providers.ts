import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import { InvalidApplicationDeclaration, ProviderNotBound } from "./exceptions";
import { isProviderFactory, type ProviderFactory } from "./start";

/**
 * One provider of a storage made by `providersOf`, e.g. `Providers.audit`:
 * what a repository (`repositoryOf({ provider: Providers.audit })`) or an
 * application (`provider: Providers.main`) names. Each application that
 * registers the storage reads and writes through its own instance of it.
 */
export type ProviderSlot<Key extends string = string> = IRepositoryProvider & {
	readonly [Kind]: "provider-slot";
	/** Its key in the storage. */
	readonly key: Key;
};

/** The providers of `providersOf`, by key. */
export type ProviderStorage<Keys extends string = string> = {
	readonly [Key in Keys]: ProviderSlot<Key>;
} & { readonly [Kind]: "provider-storage" };

/** What a slot stands for. */
interface SlotEntry {
	readonly key: string;
	readonly storage: object;
	readonly value: IRepositoryProvider | ProviderFactory;
}

const slots = new WeakMap<object, SlotEntry>();
const storages = new WeakMap<object, readonly ProviderSlot[]>();

const METHODS = [
	"findOne",
	"findMany",
	"insert",
	"update",
	"remove",
	"count",
] as const;

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(["inMemory", "__proto__", "constructor", "prototype"]);

function invalid(reason: string): never {
	throw new InvalidApplicationDeclaration({
		source: "providersOf",
		details: { reason },
	});
}

function isProviderObject(value: unknown): value is IRepositoryProvider {
	return (
		typeof value === "object" &&
		value !== null &&
		!isProviderFactory(value) &&
		METHODS.some(
			(method) =>
				typeof (value as Record<string, unknown>)[method] === "function",
		)
	);
}

/**
 * A slot forwarding to `value` when it is a provider object, so that a
 * repository works outside any application; for a factory, every call throws
 * `ProviderNotBound`, since only an application makes it.
 */
function slotOf(
	key: string,
	storage: object,
	value: IRepositoryProvider | ProviderFactory,
): ProviderSlot {
	const slot: Record<PropertyKey, unknown> = {
		[Kind]: "provider-slot",
		key,
	};
	if (isProviderFactory(value)) {
		const unbound = () => {
			throw new ProviderNotBound({ source: key, details: { provider: key } });
		};
		for (const method of METHODS) slot[method] = unbound;
		slot.transaction = unbound;
		Object.defineProperty(slot, "capabilities", {
			get: () => undefined,
			enumerable: true,
		});
	} else {
		const target = value as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		for (const method of [...METHODS, "transaction", "close"]) {
			if (typeof target[method] === "function") {
				slot[method] = (...args: unknown[]) => target[method]?.(...args);
			}
		}
		Object.defineProperty(slot, "capabilities", {
			get: () => value.capabilities,
			enumerable: true,
		});
	}
	Object.freeze(slot);
	slots.set(slot, { key, storage, value });
	return slot as unknown as ProviderSlot;
}

/**
 * Named providers, declared once in a module of their own so that
 * repositories can name one before any application exists, e.g.
 * `const Providers = providersOf({ main: providerFrom(Database, ...), audit: auditProvider() })`,
 * then `repositoryOf({ ..., provider: Providers.audit })` and
 * `applicationOf({ providers: Providers, provider: Providers.main, ... })`.
 * Each value is a provider or a factory of `providerFrom`; an application
 * that registers the storage makes each factory on `start()`, its own
 * instance (an application that extends it shares them).
 */
export function providersOf<
	const Entries extends Readonly<
		Record<string, IRepositoryProvider | ProviderFactory>
	>,
>(entries: Entries): ProviderStorage<keyof Entries & string> {
	if (
		typeof entries !== "object" ||
		entries === null ||
		Array.isArray(entries) ||
		Object.keys(entries).length === 0
	) {
		invalid("Expected an object of providers by key.");
	}
	const storage: Record<PropertyKey, unknown> = Object.create(null);
	storage[Kind] = "provider-storage";
	const seen = new Map<unknown, string>();
	const list: ProviderSlot[] = [];
	for (const [key, value] of Object.entries(entries)) {
		if (!KEY.test(key) || RESERVED.has(key)) {
			invalid(
				key === "inMemory"
					? `"inMemory" is the built-in provider; choose another key.`
					: `Expected "${key}" to be an identifier that is not reserved.`,
			);
		}
		if (isProviderSlot(value)) {
			invalid(
				`"${key}" holds a provider of another storage; a storage holds providers, not slots.`,
			);
		}
		if (!isProviderFactory(value) && !isProviderObject(value)) {
			invalid(
				`Expected "${key}" to be a repository provider or a factory of providerFrom.`,
			);
		}
		const other = seen.get(value);
		if (other !== undefined) {
			invalid(`"${other}" and "${key}" hold the same provider.`);
		}
		seen.set(value, key);
		const slot = slotOf(key, storage, value);
		storage[key] = slot;
		list.push(slot);
	}
	Object.freeze(storage);
	storages.set(storage, Object.freeze(list));
	return storage as ProviderStorage<keyof Entries & string>;
}

/** Whether `value` is a provider of a storage made by `providersOf`. */
export function isProviderSlot(value: unknown): value is ProviderSlot {
	return typeof value === "object" && value !== null && slots.has(value);
}

/** Whether `value` is a storage made by `providersOf`. */
export function isProviderStorage(value: unknown): value is ProviderStorage {
	return typeof value === "object" && value !== null && storages.has(value);
}

/** The slots of `storage`, in the order of its keys. @internal */
export function slotsOf(storage: ProviderStorage): readonly ProviderSlot[] {
	return storages.get(storage) ?? [];
}

/** What `slot` stands for. @internal */
export function slotEntry(slot: ProviderSlot): SlotEntry {
	return slots.get(slot) as SlotEntry;
}
