import { eventPolicyCatalogOf } from "../core/event-policy/event-policy";
import { publishEvents } from "../core/event-policy/publish";

/** The built-in event policies by name; adapters add their own with `eventPolicyCatalogOf`. */
export const StdEventPolicies = eventPolicyCatalogOf(publishEvents);
