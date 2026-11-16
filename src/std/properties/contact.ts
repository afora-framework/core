import { type TSchema, Type } from "typebox";
import { recordPropertyLineage } from "../../core/property/lineage";
import { propertyOf } from "../../core/property/property";
import { derivePropertyOf, refinePropertyOf } from "../../core/property/refine";
import type { AnyPropertyConstructor } from "../../core/property/types/property-collection.type";
import type { PropertyOptions } from "../../core/property/types/property-options.interface";
import { rawTypeOf, schemaOf } from "../../core/schema/schema";
import { InvalidUrlOptions } from "./exceptions";

/** An email address of up to 254 characters, trimmed and lowercased. */
export const Email = propertyOf({
	name: "email",
	schema: Type.String({ format: "email", maxLength: 254 }),
	default: "demo@example.com",
	preHandle: (value) => value.trim().toLowerCase(),
});

/** A phone number in E.164; spaces, dots, dashes and parentheses are dropped. */
export const Phone = propertyOf({
	name: "phone",
	schema: Type.String({ pattern: "^\\+[1-9]\\d{1,14}$" }),
	default: "+5511999999999",
	preHandle: (value) => value.replace(/[\s().-]/g, ""),
});

/** The protocols `Url` rejects unless `Url.with({ protocols })` lists them: they run script or read local files. */
const UNSAFE_PROTOCOLS = [
	"javascript:",
	"data:",
	"vbscript:",
	"file:",
] as const;

/** A URL scheme with its colon, as `URL.protocol` gives it: `https:`, `mailto:`. */
const PROTOCOL = /^[a-z][a-z0-9+.-]*:$/i;

/** What the URL parser drops before the scheme: C0 controls and spaces. */
const LEADING = "[\\x00-\\x20]*";

/** What the URL parser drops anywhere in the scheme: tabs and newlines. */
const DROPPED = "[\\t\\n\\r]*";

/**
 * A pattern of the start of a URL whose protocol, as `new URL(value).protocol`
 * reads it, is one of `protocols`: in any case, after the C0 controls and
 * spaces the parser drops before it, and with the tabs and newlines it drops
 * inside it (`" Java\tScript:"` is `javascript:`). Equivalent to comparing
 * the parsed protocol, for a value the `url` format accepts.
 */
function protocolsAt(protocols: readonly string[], source: string): string {
	if (protocols.length === 0) {
		throw new InvalidUrlOptions({
			source,
			details: { reason: "protocols is empty" },
		});
	}
	const alternatives = protocols.map((protocol) => {
		if (typeof protocol !== "string" || !PROTOCOL.test(protocol)) {
			throw new InvalidUrlOptions({
				source,
				details: {
					reason: `${JSON.stringify(protocol)} is not a protocol, such as "https:"`,
				},
			});
		}
		return [...protocol.slice(0, -1).toLowerCase()]
			.map((char) =>
				/[a-z]/.test(char)
					? `[${char}${char.toUpperCase()}]`
					: /[0-9]/.test(char)
						? char
						: `[${char}]`,
			)
			.join(DROPPED);
	});
	return `${LEADING}(?:${alternatives.join("|")})${DROPPED}:`;
}

/** A pattern that a URL matches when its protocol is one of `protocols`. */
function allowedPattern(protocols: readonly string[], source: string): string {
	return `^${protocolsAt(protocols, source)}`;
}

/** A pattern that a URL matches when its protocol is none of `protocols`. */
function deniedPattern(protocols: readonly string[], source: string): string {
	return `^(?!${protocolsAt(protocols, source)})`;
}

/** What `Url.with` takes: the options of any string property, and `protocols`. */
export type UrlOptions = PropertyOptions<Type.TString, string> & {
	/**
	 * The protocols accepted, each with its colon (`["https:", "mailto:"]`),
	 * and only those: an allowlist that replaces the protocols of the class it
	 * narrows (every protocol but `javascript:`, `data:`, `vbscript:` and
	 * `file:` for `Url`).
	 */
	readonly protocols?: readonly string[];
};

/** `Base.with(options)` for `Url` and its subclasses: `protocols` replaces those it accepts. */
function urlWith<Base extends AnyPropertyConstructor>(
	Base: Base,
	options: UrlOptions,
): Base {
	const { protocols, ...rest } = options;
	if (protocols === undefined) {
		return refinePropertyOf(Base, rest as PropertyOptions<TSchema>);
	}
	const base = Base.type;
	const schema = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(rawTypeOf(base.schema)),
	) as TSchema & { pattern?: string };
	schema.pattern = allowedPattern(protocols, base.name);
	const SchemaConstructor = schemaOf(base.name, schema);
	const Widened = derivePropertyOf(Base, {
		...base,
		schema: new SchemaConstructor(),
	}) as Base;
	recordPropertyLineage(Widened, {
		kind: "refined",
		base: Base,
		options: Object.freeze({ protocols: Object.freeze([...protocols]) }),
	});
	return Object.keys(rest).length === 0
		? Widened
		: refinePropertyOf(Widened, rest as PropertyOptions<TSchema>);
}

/**
 * A URL of up to 2048 characters, trimmed, of any protocol but `javascript:`,
 * `data:`, `vbscript:` and `file:` (in any case, however written).
 * `Url.with({ protocols: ["https:", "mailto:"] })` accepts only the
 * protocols it lists, instead.
 */
export class Url extends propertyOf({
	name: "url",
	schema: Type.String({
		format: "url",
		maxLength: 2048,
		pattern: deniedPattern(UNSAFE_PROTOCOLS, "url"),
	}),
	default: "https://example.com",
	preHandle: (value) => value.trim(),
}) {
	/**
	 * A subclass narrowed and documented by `options`, as for any property;
	 * `protocols` replaces the protocols it accepts.
	 */
	static override with<Self extends AnyPropertyConstructor>(
		this: Self,
		options: UrlOptions,
	): Self {
		// biome-ignore lint/complexity/noThisInStatic: the class it is called on, a subclass included
		return urlWith(this, options);
	}
}

/** An IPv4 or IPv6 address, trimmed. */
export const Ip = propertyOf({
	name: "ip",
	schema: Type.Union([
		Type.String({ format: "ipv4" }),
		Type.String({ format: "ipv6" }),
	]),
	default: "127.0.0.1",
	preHandle: (value) => value.trim(),
});
