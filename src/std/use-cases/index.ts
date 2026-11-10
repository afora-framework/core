import { useCaseCatalogOf } from "../../core/use-case/plugin-catalog";
import type { IUseCaseCatalog } from "../../core/use-case/types/plugin.interface";
import { login, register } from "./auth";
import { create, delete_, get, list, restore, update } from "./crud";
import {
	archive,
	publish,
	tag,
	unarchive,
	unpublish,
	untag,
} from "./lifecycle";
import type { StdUseCasePlugins } from "./types";

/**
 * The standard use cases, by name, for the `useCases` of `commandOf` to
 * pick from, as `(ctx) => ({ create: ctx.create(Posts) })`: `create`, `get`,
 * `list`, `update`, `delete` and `restore` for any entity; `publish`,
 * `unpublish`, `archive`, `unarchive`, `tag` and `untag` for the entities
 * with those record plugins; `register` and `login` for the
 * authenticatable ones. `StdUseCases.context` is that `ctx`.
 */
// Annotated: inferring the catalog from fourteen plugins is costly to check.
export const StdUseCases: IUseCaseCatalog<StdUseCasePlugins> = useCaseCatalogOf(
	create,
	get,
	list,
	update,
	delete_,
	restore,
	publish,
	unpublish,
	archive,
	unarchive,
	tag,
	untag,
	register,
	login,
) as unknown as IUseCaseCatalog<StdUseCasePlugins>;
