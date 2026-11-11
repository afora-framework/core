import { Kind } from "../symbols/kind";
import { accessDeclarationOf } from "./access";
import { routeDeclarationOf } from "./route";
import type { AccessDeclaration } from "./types/access.interface";
import type { RouteSettings } from "./types/route.interface";
import { type AnyUseCaseClass, InvalidUseCaseDeclaration } from "./use-case";

/** What a decorator of this module is given besides the class: nothing it reads. */
type ClassContext = { readonly kind: string };

/** A class decorator for use cases, in the standard form and in the legacy one of TypeScript. */
export type UseCaseDecorator = <
	UseCase extends abstract new (
		// biome-ignore lint/suspicious/noExplicitAny: any use case constructor
		...args: any[]
	) => unknown,
>(
	value: UseCase,
	context?: ClassContext,
) => void;

/** The use case class a decorator was put on, or a throw naming the decorator. */
function decoratedUseCase(value: unknown, decorator: string): AnyUseCaseClass {
	if (
		typeof value !== "function" ||
		(value as { [Kind]?: unknown })[Kind] !== "use-case"
	) {
		throw new InvalidUseCaseDeclaration({
			source: decorator,
			details: {
				reason: `${decorator} decorates a class that extends useCaseOf(...).`,
			},
		});
	}
	return value as unknown as AnyUseCaseClass;
}

/**
 * Says where a use case is served over HTTP, on the class itself:
 *
 * ```ts
 * @Route("GET", "/posts/{slug}", { query: ["page"], cookie: { session: "sid" } })
 * class ListPosts extends useCaseOf({ name: "ListPosts", blueprint, response }) {}
 * ```
 *
 * The same as the `route` setting of `useCaseOf` (see `RouteDeclaration`), so
 * `describe()`, the sinks and `afora.json` see one declaration. It names no
 * server: the sink of an output does. Throws `InvalidUseCaseDeclaration` on
 * a class that is not a use case, on one that already has a route, and for a
 * route that does not fit the input of the use case.
 */
export function Route(
	method: RouteSettings["method"],
	path?: string,
	options?: Omit<RouteSettings, "method" | "path">,
): UseCaseDecorator;
export function Route(
	method: RouteSettings["method"],
	options?: Omit<RouteSettings, "method" | "path">,
): UseCaseDecorator;
export function Route(
	method: RouteSettings["method"],
	pathOrOptions?: string | Omit<RouteSettings, "method" | "path">,
	options?: Omit<RouteSettings, "method" | "path">,
): UseCaseDecorator {
	const settings =
		typeof pathOrOptions === "string"
			? { ...options, method, path: pathOrOptions }
			: { ...pathOrOptions, method };
	return (value) => {
		const UseCase = decoratedUseCase(value, "@Route");
		const invalid = (reason: string): never => {
			throw new InvalidUseCaseDeclaration({
				source: UseCase.useCaseName,
				details: { reason },
			});
		};
		if (UseCase.route !== undefined) {
			invalid(
				"The use case already has a route: declare it once, with the route setting or with @Route.",
			);
		}
		const declared = routeDeclarationOf(
			settings,
			UseCase.blueprint,
			UseCase.response,
		);
		if (typeof declared === "string") invalid(declared);
		Object.defineProperty(UseCase, "route", { value: declared });
	};
}

/**
 * Says who may call a use case, on the class itself:
 *
 * ```ts
 * @Access({ scopes: ["posts:write"], context: { userId: "subject" } })
 * class PublishPost extends useCaseOf({ name: "PublishPost", blueprint, response, context }) {}
 * ```
 *
 * The same as the `access` setting of `useCaseOf` (see `AccessDeclaration`).
 * Throws `InvalidUseCaseDeclaration` on a class that is not a use case, on
 * one that already declares its access, and for a declaration that does not
 * fit the input of the use case.
 */
export function Access(access: AccessDeclaration): UseCaseDecorator {
	return (value) => {
		const UseCase = decoratedUseCase(value, "@Access");
		const invalid = (reason: string): never => {
			throw new InvalidUseCaseDeclaration({
				source: UseCase.useCaseName,
				details: { reason },
			});
		};
		if (UseCase.access !== undefined) {
			invalid(
				"The use case already declares its access: declare it once, with the access setting or with @Access.",
			);
		}
		const declared = accessDeclarationOf(access, UseCase.blueprint);
		if (typeof declared === "string") invalid(declared);
		Object.defineProperty(UseCase, "access", { value: declared });
	};
}
