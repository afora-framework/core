import { checkImport, isImportObject } from "./provider";
import { checkEnvironmentNames, type Decl, issue, type Scope } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";
import { checkBlueprintRef, type InlineChecker } from "./use-case";

type Path = readonly (string | number)[];

const COMMAND_KEYS = [
	"description",
	"tags",
	"context",
	"useCases",
	"transaction",
	"environments",
	"events",
	"onEventError",
];

/** The `events` policy of a command spec, with its default. */
function eventsOf(
	spec: Record<string, unknown>,
): "after-commit" | "manual" | "handler" {
	const { events } = spec;
	if (events === undefined || events === "after-commit") return "after-commit";
	return events === "manual" ? "manual" : "handler";
}

/**
 * Checks one `commands` declaration. Whether `transaction: true` works depends
 * on the provider of the repositories, which is only known when the code runs
 * (`commandOf` throws `InvalidCommandDeclaration` then), so it is not checked here.
 */
export function checkCommand(
	decl: Decl,
	scope: Scope,
	inline: InlineChecker,
	issues: SpecIssue[],
): void {
	const path: Path = ["commands", decl.name];
	const { spec } = decl;
	for (const key of Object.keys(spec)) {
		if (!COMMAND_KEYS.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid here. Valid keys: ${COMMAND_KEYS.join(", ")}.`,
				),
			);
		}
	}
	if (spec.description !== undefined && typeof spec.description !== "string") {
		issues.push(
			issue(
				[...path, "description"],
				"invalid_option",
				'"description" must be a string.',
			),
		);
	}
	if (spec.transaction !== undefined && typeof spec.transaction !== "boolean") {
		issues.push(
			issue(
				[...path, "transaction"],
				"invalid_option",
				'"transaction" must be a boolean.',
			),
		);
	}
	checkEnvironmentNames(
		spec.environments,
		[...path, "environments"],
		scope,
		issues,
	);
	if (spec.tags !== undefined) {
		const { tags } = spec;
		if (
			!Array.isArray(tags) ||
			tags.some((tag) => typeof tag !== "string" || tag === "") ||
			new Set(tags).size !== tags.length
		) {
			issues.push(
				issue(
					[...path, "tags"],
					"invalid_option",
					'"tags" must be distinct, non-empty strings.',
				),
			);
		}
	}
	if (spec.context !== undefined) {
		checkBlueprintRef(
			spec.context,
			[...path, "context"],
			scope,
			inline,
			issues,
		);
	}

	const operations = spec.useCases;
	if (!isObject(operations) || Object.keys(operations).length === 0) {
		issues.push(
			issue(
				[...path, "useCases"],
				"invalid_use_cases",
				'"useCases" is required: a non-empty object of operation name -> use case name, e.g. { "register": "Register" }.',
			),
		);
	} else {
		for (const [op, name] of Object.entries(operations)) {
			const here = [...path, "useCases", op];
			if (!isIdentifier(op)) {
				issues.push(
					issue(
						here,
						"invalid_operation",
						`"${op}" is not a valid operation name: use an identifier (letters, digits, _ and $, not starting with a digit).`,
					),
				);
			}
			const target =
				typeof name === "string" ? scope.decls.get(name) : undefined;
			if (target?.kind !== "useCase") {
				issues.push(
					issue(
						here,
						target ? "wrong_kind" : "unknown_use_case",
						target
							? `"${name}" is a ${target.kind}; an operation needs a use case.`
							: `${typeof name === "string" ? `"${name}"` : "The operation"} is not a declared use case. Declare it in useCases first.`,
					),
				);
			}
		}
	}

	const { events, onEventError } = spec;
	if (
		events !== undefined &&
		events !== "after-commit" &&
		events !== "manual"
	) {
		if (isImportObject(events)) {
			checkImport(events, [...path, "events"], issues);
		} else {
			issues.push(
				issue(
					[...path, "events"],
					"invalid_events",
					'"events" is "after-commit" (default), "manual" or { "import": "./events.ts#dispatch" }.',
				),
			);
		}
	}
	if (onEventError !== undefined) {
		if (isImportObject(onEventError)) {
			checkImport(onEventError, [...path, "onEventError"], issues);
		} else {
			issues.push(
				issue(
					[...path, "onEventError"],
					"invalid_import",
					'"onEventError" is a function written by hand: { "import": "./events.ts#onError" }.',
				),
			);
		}
		if (eventsOf(spec) !== "after-commit") {
			issues.push(
				issue(
					[...path, "onEventError"],
					"event_error_requires_after_commit",
					'"onEventError" only applies to the "after-commit" policy.',
				),
			);
		}
	}
}
