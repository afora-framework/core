import type { AnyRepository } from "../core/repository/types/repository.interface";
import type { AccessDeclaration } from "../core/use-case/types/access.interface";
import type { RouteSettings } from "../core/use-case/types/route.interface";
import type {
	ResourceAction,
	ResourceOptions,
	ResourceUseCases,
	StdUseCaseContext,
} from "./use-cases/types";

const ACTIONS: readonly ResourceAction[] = [
	"create",
	"get",
	"list",
	"update",
	"delete",
];

/** The route of each operation of a resource at `path`. */
function routeOf(action: ResourceAction, path: string): RouteSettings {
	switch (action) {
		case "create":
			return { method: "post", path, status: 201 };
		case "list":
			return { method: "get", path };
		case "get":
			return { method: "get", path: `${path}/{id}` };
		case "update":
			return { method: "patch", path: `${path}/{id}` };
		default:
			return { method: "delete", path: `${path}/{id}` };
	}
}

/**
 * The use cases of a CRUD resource over `repository`, for the `useCases` of
 * `commandOf`: the standard `create`, `get`, `list`, `update` and `delete`,
 * each with the route of a REST resource at `path`.
 *
 * ```ts
 * const Blog = commandOf({
 * 	name: "Blog",
 * 	useCases: resourceOf(Posts, { path: "/posts" }),
 * });
 * // POST /posts (201), GET /posts, GET /posts/{id}, PATCH /posts/{id}, DELETE /posts/{id}
 * ```
 *
 * It is only a shortcut for
 * `(ctx) => ({ create: ctx.create(Posts, { route }), ... })`: the command it
 * goes into is an ordinary one, and `describe()` shows the same standard use
 * cases. `actions` picks some of the operations, and `access` says who may
 * call them. A repository that lacks the action of an operation throws
 * `UseCaseUnavailable` when the command is declared. For anything else an
 * operation needs (`omit`, `owner`, hooks), write that one with `ctx` and
 * spread the rest: `(ctx) => ({ ...resourceOf(Posts, options)(ctx), create: ctx.create(Posts, { ... }) })`.
 */
export function resourceOf<
	Repository extends AnyRepository,
	const Actions extends readonly ResourceAction[] = readonly [
		"create",
		"get",
		"list",
		"update",
		"delete",
	],
>(
	repository: Repository,
	options: ResourceOptions<Actions>,
): (
	ctx: StdUseCaseContext,
) => Pick<ResourceUseCases<Repository>, Actions[number]> {
	const actions = options.actions ?? ACTIONS;
	const { access } = options;
	const byAction =
		access !== undefined &&
		Object.keys(access).some((key) =>
			(ACTIONS as readonly string[]).includes(key),
		);
	const accessOf = (action: ResourceAction): AccessDeclaration | undefined =>
		byAction
			? (access as Partial<Record<ResourceAction, AccessDeclaration>>)[action]
			: (access as AccessDeclaration | undefined);
	return (ctx) => {
		const useCases: Record<string, unknown> = {};
		for (const action of actions) {
			const declared = accessOf(action);
			const make = ctx[action] as unknown as (
				repository: AnyRepository,
				options: object,
			) => unknown;
			useCases[action] = make(repository, {
				route: routeOf(action, options.path),
				...(declared === undefined ? {} : { access: declared }),
			});
		}
		return useCases as Pick<ResourceUseCases<Repository>, Actions[number]>;
	};
}
