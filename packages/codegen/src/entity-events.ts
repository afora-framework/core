import { checkImport, isImportObject } from "./provider";
import { issue, type Scope } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";

/** The lifecycle cycles an entity spec can name events for, in order. */
export const CYCLES = ["onCreate", "onUpdate", "onDelete"] as const;
export type Cycle = (typeof CYCLES)[number];

/** One event of an entity: its name and, when it has one, the import of its handler. */
export interface EntityEventEntry {
	readonly name: string;
	readonly handler?: string;
}

/** The name of the object the events of entity `name` are generated in: `PostEvents`. */
export const eventsConstOf = (name: string): string => `${name}Events`;

/** One event as written: `"created"` or `{ "name": "created", "handler": { "import": ... } }`. */
function entryOf(value: unknown): EntityEventEntry | undefined {
	if (typeof value === "string") return { name: value };
	if (isObject(value) && typeof value.name === "string") {
		return isImportObject(value.handler)
			? { name: value.name, handler: String(value.handler.import) }
			: { name: value.name };
	}
	return undefined;
}

/** The events of each cycle as written, a single event made a list. */
export function cyclesOf(
	events: unknown,
): Partial<Record<Cycle, readonly EntityEventEntry[]>> {
	if (!isObject(events)) return {};
	const found: Partial<Record<Cycle, EntityEventEntry[]>> = {};
	for (const cycle of CYCLES) {
		const value = events[cycle];
		if (value === undefined) continue;
		found[cycle] = (Array.isArray(value) ? value : [value])
			.map(entryOf)
			.filter((entry): entry is EntityEventEntry => entry !== undefined);
	}
	return found;
}

/** Every distinct event of an entity spec, by name, in the order they appear. */
export function eventEntriesOf(events: unknown): EntityEventEntry[] {
	const byName = new Map<string, EntityEventEntry>();
	for (const list of Object.values(cyclesOf(events))) {
		for (const entry of list) {
			if (!byName.has(entry.name)) byName.set(entry.name, entry);
		}
	}
	return [...byName.values()];
}

/**
 * Checks the `events` of an entity: an object of `onCreate`, `onUpdate`
 * and `onDelete`, each one event or a non-empty list of them; an event is
 * an identifier, or `{ name, handler: { import } }`. One name is one event,
 * so naming it twice with different handlers is `event_conflict`. The
 * events are generated in `<Name>Events`, which no declaration may take.
 */
export function checkEntityEvents(
	name: string,
	events: unknown,
	path: readonly (string | number)[],
	scope: Scope,
	issues: SpecIssue[],
): void {
	if (!isObject(events)) {
		issues.push(
			issue(
				path,
				"invalid_events",
				'"events" is { "onCreate"?, "onUpdate"?, "onDelete"? }, each an event name or a list of them.',
			),
		);
		return;
	}
	for (const key of Object.keys(events)) {
		if (!(CYCLES as readonly string[]).includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not a cycle. Valid keys: ${CYCLES.join(", ")}.`,
				),
			);
		}
	}
	const handlers = new Map<string, string | undefined>();
	for (const cycle of CYCLES) {
		const value = events[cycle];
		if (value === undefined) continue;
		const list = Array.isArray(value) ? value : [value];
		if (list.length === 0) {
			issues.push(
				issue(
					[...path, cycle],
					"invalid_events",
					`"${cycle}" lists no event: remove it or name one.`,
				),
			);
		}
		for (const [index, item] of list.entries()) {
			const here = Array.isArray(value)
				? [...path, cycle, index]
				: [...path, cycle];
			const object = isObject(item);
			if (object) {
				for (const key of Object.keys(item)) {
					if (key !== "name" && key !== "handler") {
						issues.push(
							issue(
								[...here, key],
								"unknown_key",
								`"${key}" is not a key of an event: { "name", "handler"? }.`,
							),
						);
					}
				}
			}
			const eventName = object ? item.name : item;
			if (typeof eventName !== "string" || !isIdentifier(eventName)) {
				issues.push(
					issue(
						here,
						"invalid_event",
						'An event is an identifier ("created") or { "name": "created", "handler": { "import": "./events.ts#onCreated" } }.',
					),
				);
				continue;
			}
			let handler: string | undefined;
			if (object && item.handler !== undefined) {
				if (isImportObject(item.handler)) {
					checkImport(item.handler, [...here, "handler"], issues);
					handler = String(item.handler.import);
				} else {
					issues.push(
						issue(
							[...here, "handler"],
							"invalid_import",
							'A handler is written by hand: { "import": "./events.ts#onCreated" }.',
						),
					);
				}
			}
			if (handlers.has(eventName) && handlers.get(eventName) !== handler) {
				issues.push(
					issue(
						here,
						"event_conflict",
						`The event "${eventName}" is named again with another handler; one name is one event.`,
					),
				);
			} else handlers.set(eventName, handler);
		}
	}
	const holder = eventsConstOf(name);
	if (handlers.size > 0 && scope.decls.has(holder)) {
		issues.push(
			issue(
				path,
				"name_collision",
				`The events of "${name}" are generated as "${holder}", which another declaration already takes. Rename it.`,
			),
		);
	}
}
