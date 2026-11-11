/**
 * Generates docs/reference/exceptions.md: every exception class exported by
 * `@afora/core`, `/adapters`, `/experimental` and `/testing` (found at
 * runtime with `isDeclaredException`), grouped by layer, with what throws it
 * (its JSDoc summary), the status `statusOf` gives it and how to handle it
 * (`HANDLING` below), plus the names raised without a class. Reads `src/`,
 * needs no build. Deterministic.
 *
 * The status is computed by `statusOf` on an instance made without running
 * the constructor, with `details.issues` when the type of its `details`
 * declares `issues` (read with the TypeScript checker).
 *
 * A new exported exception needs a line in `HANDLING`: the script fails
 * while one is missing, and while `HANDLING` names one that is not exported.
 *
 *   bun scripts/gen-exceptions-reference.ts          write the file
 *   bun scripts/gen-exceptions-reference.ts --check  exit 1 when the file differs or HANDLING is incomplete
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-language-service";
import { ExceptionLayers } from "../src/core/exception/enums/exception-layers";
import {
	type DeclaredExceptionClass,
	Exception,
	isDeclaredException,
} from "../src/core/exception/exception";
import { statusOf } from "../src/core/output/status";
import {
	baseOptions,
	entryPoints,
	root,
	type Tier,
} from "../tests/api-surface/program";

const target = join(root, "docs/reference/exceptions.md");

const DECLARATION =
	"A mistake in the code, raised when the module loads or the declaration is first used: fix the declaration. Do not catch it.";
const START =
	"Raised by `app.start()`, before the application serves anything: fix the configuration or the deployment, and let the process fail.";
const INPUT =
	"Invalid input from the caller. An output answers it as a 400 problem+json with the `issues`; in your own code, read `details.issues`.";
const BUG =
	"A mistake in the calling code, not something a caller can cause: fix the call.";

/** How to handle each exported exception, by name. */
const HANDLING: Record<string, string> = {
	ApplicationAlreadyStarted:
		"Start one application per process, stop the started one first, or pass `start({ replace: true })` (in tests).",
	ApplicationConflict: DECLARATION,
	ApplicationNotStarted: "`await app.start()` before the first call.",
	CommandEventFailed:
		"The call itself succeeded (and committed): do not retry it. Handle or retry the `remaining` events, e.g. from an outbox.",
	DeletedEntity:
		"Check `entity.deletedAt` (or reload the entity) before changing it.",
	DuplicateApplicationDeclaration: DECLARATION,
	DuplicateOperation: `${DECLARATION} Give each operation its own id.`,
	Forbidden:
		"An output answers 403. In your own code, check the scopes or the owner before calling, or let it through.",
	ImmutableEntityKey: `${BUG} The identity keys are set by the entity and the repository.`,
	IncompatibleRecordPlugin:
		"Install the plugin version the catalog reference asks for, or update the reference.",
	IncompatibleUseCasePlugin:
		"Install the plugin version the catalog reference asks for, or update the reference.",
	InvalidApplicationDeclaration: DECLARATION,
	InvalidApplicationEnvironment: `${START} \`details.environments\` lists the keys to set.`,
	InvalidBlueprintVariant: DECLARATION,
	InvalidCommandContext: INPUT,
	InvalidCommandDeclaration: DECLARATION,
	InvalidCommandEnvironment:
		"Configuration, not input (an output answers 500): fix the `env` given to the call or the environment blueprint.",
	InvalidEntityExpiry: DECLARATION,
	InvalidEntitySchemaVersion: DECLARATION,
	InvalidEnvironment:
		"Set or fix the variable named in the message; validate environments at start (`app.start()`) so it fails before serving.",
	InvalidEventPolicy: DECLARATION,
	InvalidJsonData: INPUT,
	InvalidJsonSchema:
		"Fix the schema; for a schema loaded at runtime, check it when it is saved, not when it is used.",
	InvalidJwtOptions: `${DECLARATION} Set the secret in the environment.`,
	InvalidLogDeclaration: DECLARATION,
	InvalidOpenAPIModel: DECLARATION,
	InvalidOutputStage: DECLARATION,
	InvalidPropertyValue:
		"Thrown by a property built on its own. A record passes it up to the `Record` layer with the key in `details`, and a use case reports it as an issue; use `safeParse` to collect every issue instead of catching it.",
	InvalidRecordDeclaration: DECLARATION,
	InvalidRecordPlugin: DECLARATION,
	InvalidRecordValue: `${INPUT} Use \`Record.safeParse\` where invalid input is expected.`,
	InvalidRepositoryCursor: INPUT,
	InvalidRepositoryData:
		"A stored row does not fit the entity (a migration is missing, or another writer). Fix the data or add a schema evolution step; the cause says which key.",
	InvalidRepositoryDeclaration: DECLARATION,
	InvalidRepositoryEntity: `${BUG} Pass an instance of the repository's entity.`,
	InvalidRepositoryIncrement: INPUT,
	InvalidRepositoryQuery:
		"Fix the query: only declared keys, a supported ordering and pagination. When the query comes from a caller, validate it first.",
	InvalidSchemaMigration: DECLARATION,
	InvalidStoredSchemaVersion:
		"A row written by newer code, or a broken `upgrade` step: deploy the newer code, or fix the step.",
	InvalidUseCaseDeclaration: DECLARATION,
	InvalidUseCaseDependencies: BUG,
	InvalidUseCasePlugin: DECLARATION,
	InvalidUseCaseStep: `${DECLARATION} \`details.index\` is the step.`,
	PasswordHasherRequired:
		"Call `configure({ hasher })` at start on a runtime without argon2 (browsers, Workers, Node < 24.7). See [Runtime](../runtime.md).",
	PropertyRequired:
		"Thrown by a property built on its own (`new Email(undefined)`). A record, a blueprint or a use case reports it as a `required` issue instead; use `safeParse` to collect it.",
	ProviderNotBound:
		"Call the repository through the application (`app.repositories.<key>`, `app.run`) after `app.start()`.",
	PublisherNotBound:
		"Declare the publisher in the application that binds the command (`publishers`).",
	RecordPluginConflict: DECLARATION,
	RepositoryConcurrencyConflict:
		"An output answers 409. Reload the entity, apply the change again and retry, or ask the caller to.",
	RepositoryEntityNotFound: "An output answers 404.",
	RepositoryUniqueViolation:
		"An output answers 409; `details.key` names the unique key.",
	RepositoryUsedOutsideApplication:
		"Call it through the application: `app.repositories.<key>`, its use cases, or a repository given to `execute`.",
	ReservedBlueprintKey: DECLARATION,
	ReservedEntityKey: DECLARATION,
	ReservedRecordKey: `${DECLARATION} Rename the key or the member.`,
	SchemaLockMismatch: `${START} \`details.problems\` lists each entity; add \`previousNames\` or raise \`schemaVersion\`.`,
	SyncVerifyUnsupported:
		"Use `await password.verify(input)`, or configure a hasher with `verifySync`.",
	Unauthenticated: "An output answers 401.",
	UndeclaredBlueprintProperty: DECLARATION,
	UndeclaredRecordProperty: `${INPUT} The value is rejected, never trimmed: drop the key before building the record.`,
	UnknownCommandOperation:
		"An output answers 404. In your own code, call an operation the command declares.",
	UnknownRecordPlugin: DECLARATION,
	UnknownUseCasePlugin: DECLARATION,
	UnregisteredApplicationReference: `${DECLARATION} Register it in the application.`,
	UnregisteredRepositoryDependency: `${DECLARATION} Register it in the application.`,
	UnregisteredUseCaseDependency: `${DECLARATION} Register it in the application.`,
	UseCaseAlreadyExecuted: `${BUG} Create a new instance for each call (\`app.run\` and commands do).`,
	UseCaseEntityConflict:
		"An output answers 409. Pass your own error in the use case's options to name it in your domain.",
	UseCaseEntityNotFound:
		"An output answers 404. Pass your own error in the use case's options to name it in your domain.",
	UseCaseInvalidCredentials:
		"An output answers 401. Do not tell the caller which part did not match.",
	UseCaseUnavailable: `${DECLARATION} Add the action to the repository, or the record plugin to the entity.`,
};

/** Names a use case or the runtime raises as a plain `Exception`, without a class to import. */
const UNNAMED: {
	name: string;
	layer: ExceptionLayers;
	when: string;
	handling: string;
	issues: boolean;
}[] = [
	{
		name: "InvalidUseCaseInput",
		layer: ExceptionLayers.UseCase,
		when: "The input of a call does not fit the input blueprint of the use case.",
		handling: INPUT,
		issues: true,
	},
	{
		name: "InvalidUseCaseContext",
		layer: ExceptionLayers.UseCase,
		when: "The context of a call does not fit the context blueprint of the use case.",
		handling: INPUT,
		issues: true,
	},
	{
		name: "InvalidUseCaseResponse",
		layer: ExceptionLayers.UseCase,
		when: "What a use case returns does not fit its response blueprint.",
		handling:
			"A mistake in the use case: fix what it returns. It carries `issues`, so `statusOf` gives 400; map it with `statuses` to answer 500.",
		issues: true,
	},
	{
		name: "UnexpectedError",
		layer: ExceptionLayers.UseCase,
		when: "An error that is not an `Exception`, wrapped by `Exception.from` (by `guard`, a use case or a command); the original is its `cause`.",
		handling:
			"An output answers 500 and logs it. Find the cause and throw a declared exception instead.",
		issues: false,
	},
];

interface Row {
	name: string;
	tier: Tier;
	layer: ExceptionLayers;
	when: string;
	status: number;
	handling: string;
}

const tierOf = new Map<string, Tier>();
const classes = new Map<string, DeclaredExceptionClass<never>>();
for (const entry of entryPoints) {
	const module = (await import(entry.src)) as Record<string, unknown>;
	for (const [name, value] of Object.entries(module)) {
		if (!isDeclaredException(value) || classes.has(name)) continue;
		classes.set(name, value);
		tierOf.set(name, entry.tier);
	}
}

/** JSDoc summary and whether `details` declares `issues`, for each class, from one program. */
const program = ts.createProgram(
	entryPoints.map((entry) => entry.src),
	baseOptions,
);
const checker = program.getTypeChecker();
const facts = new Map<string, { summary: string; issues: boolean }>();
for (const entry of entryPoints) {
	const source = program.getSourceFile(entry.src);
	const moduleSymbol = source && checker.getSymbolAtLocation(source);
	if (!moduleSymbol) throw new Error(`Cannot read ${entry.src}.`);
	for (const exported of checker.getExportsOfModule(moduleSymbol)) {
		if (!classes.has(exported.name) || facts.has(exported.name)) continue;
		const symbol =
			exported.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol(exported)
				: exported;
		const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
		const type = declaration
			? checker.getTypeOfSymbolAtLocation(symbol, declaration)
			: undefined;
		const args = type?.getConstructSignatures()[0]?.getParameters()[0];
		const argsType =
			args && declaration
				? checker.getTypeOfSymbolAtLocation(args, declaration)
				: undefined;
		const details = argsType?.getProperty("details");
		const detailsType =
			details && declaration
				? checker.getNonNullableType(
						checker.getTypeOfSymbolAtLocation(details, declaration),
					)
				: undefined;
		facts.set(exported.name, {
			summary: ts
				.displayPartsToString(symbol.getDocumentationComment(checker))
				.replace(/\s+/g, " ")
				.trim(),
			issues: !!detailsType?.getProperty("issues"),
		});
	}
}

/** The status `statusOf` gives an exception of `name`, without running a constructor. */
function statusFor(
	name: string,
	layer: ExceptionLayers,
	issues: boolean,
	Declared?: DeclaredExceptionClass<never>,
): number {
	const init = {
		layer,
		name,
		source: "reference",
		message: "",
		details: issues ? { issues: [] } : undefined,
	};
	const error = Declared
		? Reflect.construct(Exception, [init], Declared)
		: new Exception(init);
	return statusOf(error);
}

const problems: string[] = [];
const rows: Row[] = [];
for (const [name, Declared] of classes) {
	const fact = facts.get(name);
	const handling = HANDLING[name];
	if (!handling)
		problems.push(
			`${name} is exported but has no line in HANDLING (scripts/gen-exceptions-reference.ts).`,
		);
	if (!fact?.summary) problems.push(`${name} has no JSDoc summary.`);
	rows.push({
		name,
		tier: tierOf.get(name) as Tier,
		layer: Declared.layer,
		when: fact?.summary ?? "",
		status: statusFor(name, Declared.layer, fact?.issues ?? false, Declared),
		handling: handling ?? "",
	});
}
for (const name of Object.keys(HANDLING))
	if (!classes.has(name))
		problems.push(
			`HANDLING names ${name}, which is not an exported exception.`,
		);

const layerOrder = Object.values(ExceptionLayers);
const layerTitle = (layer: ExceptionLayers): string =>
	(Object.entries(ExceptionLayers).find(([, value]) => value === layer)?.[0] ??
		layer) as string;

const cell = (text: string) => text.replace(/\|/g, "\\|");

/** A Markdown table with its columns padded, as Biome formats one, so `bun run fmt` leaves it as it is. */
function table(header: string[], rows: string[][]): string[] {
	const widths = header.map((title, column) =>
		Math.max(title.length, 3, ...rows.map((row) => (row[column] ?? "").length)),
	);
	const line = (cells: string[]) =>
		`| ${cells.map((text, column) => text.padEnd(widths[column] as number)).join(" | ")} |`;
	return [
		line(header),
		line(widths.map((width) => "-".repeat(width))),
		...rows.map(line),
	];
}
const importOf = (row: Row) =>
	row.tier === "stable"
		? ""
		: ` (from \`@afora/core/${row.tier}\`${row.tier === "experimental" ? ", experimental" : ""})`;

function render(): string {
	const out: string[] = [
		"# Exceptions reference",
		"",
		"<!-- Generated by `bun run docs:api` (scripts/gen-exceptions-reference.ts) from the exported exceptions, their JSDoc and `statusOf`. Do not edit by hand: change the JSDoc in `src/` or the handling in the script, and regenerate. -->",
		"",
		`Every exception afora exports (${rows.length}), by layer, and the names it raises without a class. Each one is an \`Exception\` with a \`layer\`, a \`name\`, a \`source\` and \`details\`; [Exceptions](../exceptions.md) explains the model, \`trace\` and \`guard\`.`,
		"",
		"**Status** is what `statusOf` gives, and so what the HTTP providers and the `websocket` sink answer, as problem+json ([Outputs](../outputs.md)): 400 for invalid input (and any exception whose `details.issues` is a list), 401, 403, 404 and 409 by name, and 500 for the rest. Two settings change it: an exception listed in the operation's `errors` (`useCaseOf({ errors })`, `throws` of a standard use case) answers 422 instead of 500, and the `statuses` option of an output maps any name to the status you choose.",
		"",
		'**Catch** an exception with `error instanceof Class` when it is thrown as it is, or with `error.is(Class)` (also `is("Name")`) when it may come wrapped by an upper layer.',
		"",
	];
	for (const layer of layerOrder) {
		const inLayer = rows
			.filter((row) => row.layer === layer)
			.sort((a, b) => (a.name < b.name ? -1 : 1));
		if (inLayer.length === 0) continue;
		out.push(
			`## ${layerTitle(layer)}`,
			"",
			`Layer \`ExceptionLayers.${layerTitle(layer)}\` (\`"${layer}"\`).`,
			"",
			...table(
				["Exception", "When it is thrown", "Status", "How to handle it"],
				inLayer.map((row) => [
					`\`${row.name}\`${importOf(row)}`,
					cell(row.when),
					String(row.status),
					cell(row.handling),
				]),
			),
			"",
		);
	}
	out.push(
		"## Raised without a class",
		"",
		'These names come as a plain `Exception`: check them with `error.is("Name")` or `error.name`.',
		"",
		...table(
			["Name", "Layer", "When it is thrown", "Status", "How to handle it"],
			UNNAMED.map((unnamed) => [
				`\`${unnamed.name}\``,
				`\`${unnamed.layer}\``,
				cell(unnamed.when),
				String(statusFor(unnamed.name, unnamed.layer, unnamed.issues)),
				cell(unnamed.handling),
			]),
		),
	);
	return `${out.join("\n").trimEnd()}\n`;
}

const text = render();
if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
if (process.argv.includes("--check")) {
	const current = existsSync(target) ? readFileSync(target, "utf8") : "";
	if (current !== text) {
		console.error(
			"docs/reference/exceptions.md is out of date: run `bun run docs:api`.",
		);
		process.exit(1);
	}
	console.log(
		`docs/reference/exceptions.md is up to date (${rows.length} exceptions).`,
	);
} else {
	writeFileSync(target, text);
	console.log(
		`Wrote docs/reference/exceptions.md (${rows.length} exceptions).`,
	);
}
