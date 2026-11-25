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
	EntityHoldsFile:
		"Store where the file went (a URL, a storage key) in the entity, and keep the file in the input of the use case.",
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
	InvalidIdStrategy: DECLARATION,
	InvalidEntitySchemaVersion: DECLARATION,
	InvalidEnvironment:
		"Set or fix the variable named in the message; validate environments at start (`app.start()`) so it fails before serving.",
	InvalidEventPolicy: DECLARATION,
	InvalidFile: INPUT,
	InvalidFileOptions: DECLARATION,
	InvalidJsonData: INPUT,
	InvalidJsonSchema:
		"Fix the schema; for a schema loaded at runtime, check it when it is saved, not when it is used.",
	InvalidJwtOptions: `${DECLARATION} Set the secret in the environment.`,
	InvalidLogDeclaration: DECLARATION,
	InvalidTraceDeclaration: DECLARATION,
	InvalidUrlOptions: DECLARATION,
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
	InvalidUseCaseStep: `${DECLARATION} \`details.index\` is the step. Raised while a call runs, an output answers a 500 whose detail is masked and that has no \`issues\`.`,
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
	RepositoryIsFrozen:
		"Wrap the provider with `spyProvider` from `@afora/core/testing` to observe it, or override the member in `execute` for one call.",
	RepositoryUniqueViolation:
		"An output answers 409; `details.key` names the unique key.",
	RepositoryUsedOutsideApplication:
		"Call it through the application: `app.repositories.<key>`, its use cases, or a repository given to `execute`.",
	RepositoryWrittenOutsideApplication:
		"Register the repository in the application and call it through `app.repositories`, its use cases, or a repository given to `execute`.",
	ReservedBlueprintKey: DECLARATION,
	ReservedEntityKey: DECLARATION,
	ReservedRecordKey: `${DECLARATION} Rename the key or the member.`,
	ServiceNotBound: `${BUG} Give the service in the \`services\` of the application, or as an override of \`execute\` in a test.`,
	ServiceOutsideExecution: `${BUG} Read the service inside \`execute\`.`,
	SchemaLockMismatch: `${START} \`details.problems\` lists each entity; add \`previousNames\` or raise \`schemaVersion\`.`,
	SyncVerifyUnsupported:
		"Use `await password.verify(input)`, or configure a hasher with `verifySync`.",
	Unauthenticated: "An output answers 401.",
	UndeclaredBlueprintProperty: DECLARATION,
	UndeclaredStatus: `${BUG} An HTTP sink answers a masked 500: add the status to \`route.statuses\`, or return another one.`,
	UndeclaredRecordProperty: `${INPUT} The value is rejected, never trimmed: drop the key before building the record.`,
	UnstoredEntity: `${BUG} Create the entity first: \`create\` gives it the id the database assigns.`,
	UnsupportedIdentity: `${DECLARATION} Give the repository a provider with \`capabilities.generatedIds\` (in memory, Drizzle), or another id strategy than \`Serial\`.`,
	UnknownCommandOperation:
		"An output answers 404. In your own code, call an operation the command declares.",
	UnknownRecordPlugin: DECLARATION,
	UnknownUseCasePlugin: DECLARATION,
	UnregisteredApplicationReference: `${DECLARATION} Register it in the application.`,
	UnregisteredRepositoryDependency: `${DECLARATION} Register it in the application.`,
	UnregisteredUseCaseDependency: `${DECLARATION} Register it in the application.`,
	UnusedUseCaseReplacement: `${BUG} Replace only what a use case of the call declares; a renamed or removed dependency is listed in \`details.replacements\`.`,
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
			"A mistake in the use case: fix what it returns. An output answers a 500 whose detail is masked and that has no `issues`, even when `statuses` maps it, unless `debug` is set; in your own code, read `details.issues`.",
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

/**
 * Problems the HTTP layer of an output (`compileRoutes`, used by every HTTP
 * sink) answers on its own, before any use case runs: they have no class and
 * never reach your code, only the client. Sink-specific exceptions are listed
 * with their package.
 */
const HTTP_PROBLEMS: {
	name: string;
	status: number;
	when: string;
	handling: string;
}[] = [
	{
		name: "InvalidRequestBody",
		status: 400,
		when: "The body is not valid JSON, or a `multipart/form-data` body cannot be read (malformed, no boundary), or a multipart body reaches a route without a file field.",
		handling:
			"A client mistake: send valid JSON, or a well-formed multipart body to a route that takes a file.",
	},
	{
		name: "UnsupportedMediaType",
		status: 415,
		when: "A `multipart/form-data` body reaches a sink whose request adapter has no `form()`.",
		handling:
			"Serve the route with a sink that reads multipart (hono, express, fastify, elysia all do), or send JSON.",
	},
	{
		name: "TooManyParts",
		status: 413,
		when: "A `multipart/form-data` body has more parts than `maxParts` (1000 by default, in the HTTP options).",
		handling:
			"A client sending too many parts. Raise `maxParts` only if the route needs it; limit the body size in the server or proxy too.",
	},
	{
		name: "InvalidFileContent",
		status: 400,
		when: "A file declared as PNG, JPEG, GIF, WebP or AVIF does not start with the bytes of that type; the issue is at the key of the file.",
		handling:
			"A client mistake (or a disguised file): send a file whose content matches its type.",
	},
];

/** Exceptions a sink package declares and throws itself, by package. */
const SINK_EXCEPTIONS: {
	name: string;
	from: string;
	status: number;
	when: string;
	handling: string;
}[] = [
	{
		name: "MultipartBodyAlreadyRead",
		from: "@afora/express",
		status: 500,
		when: "Another parser of the Express app (multer, `express.text()`...) read a `multipart/form-data` body before the afora route.",
		handling:
			"A server misconfiguration: mount the afora routes before that parser, or keep the bytes with `express.raw()`.",
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

// `\` is escaped too: a `\` before a `|` would otherwise turn its `\|` back into a column break.
const cell = (text: string) => text.replace(/[\\|]/g, "\\$&");

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
		"**Status** is what `statusOf` gives, and so what the HTTP providers and the `websocket` sink answer, as problem+json ([Outputs](../outputs.md)): 400 for invalid input (and any exception whose `details.issues` is a list, except the internal ones such as `InvalidUseCaseResponse` and `InvalidUseCaseStep`, a masked 500), 401, 403, 404 and 409 by name, and 500 for the rest. Two settings change it: an exception listed in the operation's `errors` (`useCaseOf({ errors })`, `throws` of a standard use case) answers 422 instead of 500, and the `statuses` option of an output maps any name to the status you choose.",
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
	out.push(
		"",
		"## Answered by the HTTP layer",
		"",
		"An HTTP sink answers these problems itself, before any use case runs. They are not exceptions your code can catch: only the client sees them, as problem+json with this `title`.",
		"",
		...table(
			["Title", "Status", "When it is answered", "How to handle it"],
			HTTP_PROBLEMS.map((problem) => [
				`\`${problem.name}\``,
				String(problem.status),
				cell(problem.when),
				cell(problem.handling),
			]),
		),
		"",
		"## Thrown by a sink package",
		"",
		...table(
			[
				"Exception",
				"Package",
				"When it is thrown",
				"Status",
				"How to handle it",
			],
			SINK_EXCEPTIONS.map((sink) => [
				`\`${sink.name}\``,
				`\`${sink.from}\``,
				cell(sink.when),
				String(sink.status),
				cell(sink.handling),
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
