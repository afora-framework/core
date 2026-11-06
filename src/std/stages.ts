import { select } from "../core/output/select";
import { stageCatalogOf } from "../core/output/stage";

/** The built-in stages by name; adapters add their own with `stageCatalogOf`. */
export const StdStages = stageCatalogOf(select);
