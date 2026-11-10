import { startedApplication } from "../application/registry";
import { Exception, UNEXPECTED_ERROR } from "../exception/exception";
import { Kind } from "../symbols/kind";
import { InvalidLogDeclaration } from "./exceptions";

/** What a log line carries besides its event. */
export type LogFields = Readonly<Record<string, unknown>>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LogLevels: readonly LogLevel[] = Object.freeze([
	"debug",
	"info",
	"warn",
	"error",
]);

/** What logs: an application, a use case through its `Logger` dependency, your code. */
export interface ILogger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

/** One line, as a log provider gets it. */
export interface LogEntry {
	/** ISO 8601. */
	readonly at: string;
	readonly level: LogLevel;
	readonly event: string;
	readonly fields: LogFields;
	/** The name of the application that logged it. */
	readonly application: string;
}

/**
 * Where lines go: the console, JSON on stdout, a log service, memory. An
 * application writes each line to every provider of its `log`.
 */
export interface ILogProvider {
	write(entry: LogEntry): void | Promise<void>;
	/** Called on `app.stop()`, to send what is still buffered. */
	flush?(): Promise<void>;
}

/** The `log` of an application. */
export interface LogSettings {
	/** Lines below it are dropped. `"info"` by default. */
	readonly level?: LogLevel;
	readonly providers: readonly ILogProvider[];
}

/** What `logProviderOf` takes. */
export interface LogProviderSettings<Provider extends ILogProvider> {
	/** Shown by `app.describe()`; anonymous providers are opaque. */
	readonly name?: string;
	readonly write: Provider["write"];
	readonly flush?: Provider["flush"];
}

const names = new WeakMap<object, string>();

const invalid = (reason: string): never => {
	throw new InvalidLogDeclaration({ source: "log", details: { reason } });
};

/** A log provider, checked, and named for `describe()` when `name` is given. */
export function logProviderOf(
	settings: LogProviderSettings<ILogProvider>,
): ILogProvider {
	if (!settings || typeof settings.write !== "function") {
		invalid("Expected a log provider with a write function.");
	}
	if (settings.flush !== undefined && typeof settings.flush !== "function") {
		invalid("Expected flush to be a function.");
	}
	if (
		settings.name !== undefined &&
		(typeof settings.name !== "string" || settings.name.trim() === "")
	) {
		invalid("Expected the name of a log provider to be a non-empty string.");
	}
	const provider: ILogProvider = Object.freeze({
		write: settings.write,
		...(settings.flush ? { flush: settings.flush } : {}),
	});
	if (settings.name) names.set(provider, settings.name);
	return provider;
}

/** The name `logProviderOf` gave a provider, if any. */
export function logProviderNameOf(provider: ILogProvider): string | undefined {
	return names.get(provider);
}

const fieldsText = (fields: LogFields) =>
	Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";

/** A readable line on the console, by level: for local development. */
export function consoleLogProvider(): ILogProvider {
	return logProviderOf({
		name: "console",
		write: ({ at, level, event, fields, application }) => {
			const line = `${at} ${level.toUpperCase()} [${application}] ${event}${fieldsText(fields)}`;
			(level === "debug"
				? console.debug
				: level === "info"
					? console.info
					: level === "warn"
						? console.warn
						: console.error)(line);
		},
	});
}

/** One JSON object per line on stdout: for Lambda, containers, CloudWatch. */
export function jsonLogProvider(): ILogProvider {
	return logProviderOf({
		name: "json",
		write: (entry) => {
			console.log(
				JSON.stringify({
					at: entry.at,
					level: entry.level,
					application: entry.application,
					event: entry.event,
					...entry.fields,
				}),
			);
		},
	});
}

/** A provider that keeps the lines, for tests. */
export interface MemoryLogProvider extends ILogProvider {
	readonly entries: readonly LogEntry[];
	clear(): void;
}

/** Keeps every line in `entries`, for tests. */
export function memoryLogProvider(): MemoryLogProvider {
	const entries: LogEntry[] = [];
	const provider: MemoryLogProvider = Object.freeze({
		write: (entry: LogEntry) => {
			entries.push(entry);
		},
		entries,
		clear: () => {
			entries.length = 0;
		},
	});
	names.set(provider, "memory");
	return provider;
}

/** Throws unless `settings` is a usable `log`; gives it with the default level. */
export function checkLogSettings(settings: unknown): Required<LogSettings> {
	if (typeof settings !== "object" || settings === null) {
		return invalid("Expected `log` to be { level?, providers }.");
	}
	const { level = "info", providers } = settings as LogSettings;
	if (!LogLevels.includes(level)) {
		invalid(`Expected the log level to be one of ${LogLevels.join(", ")}.`);
	}
	if (
		!Array.isArray(providers) ||
		providers.some(
			(provider) =>
				typeof provider !== "object" ||
				provider === null ||
				typeof (provider as ILogProvider).write !== "function",
		)
	) {
		invalid("Expected `log.providers` to be a list of log providers.");
	}
	return Object.freeze({ level, providers: Object.freeze([...providers]) });
}

/** A logger that writes nothing. */
export const silentLogger: ILogger = Object.freeze({
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
});

const rank = (level: LogLevel) => LogLevels.indexOf(level);

/**
 * The logger of an application: drops what is below `level`, writes the rest
 * to every provider, and never lets a provider break the call or the others.
 * `settings` can be set later (a `log` made on start) and unset on stop.
 */
export function applicationLogger(application: string) {
	let current: Required<LogSettings> | undefined;
	const write =
		(level: LogLevel) =>
		(event: string, fields: LogFields = {}) => {
			if (!current || rank(level) < rank(current.level)) return;
			const entry: LogEntry = Object.freeze({
				at: new Date().toISOString(),
				level,
				event,
				fields,
				application,
			});
			for (const provider of current.providers) {
				try {
					const written = provider.write(entry);
					if (written && typeof written.catch === "function") {
						written.catch(() => {});
					}
				} catch {
					// Logging is bookkeeping.
				}
			}
		};
	const logger: ILogger = Object.freeze({
		debug: write("debug"),
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
	});
	return {
		logger,
		get settings() {
			return current;
		},
		set(settings: Required<LogSettings> | undefined) {
			current = settings;
		},
		async flush() {
			await Promise.all(
				(current?.providers ?? []).map((provider) =>
					Promise.resolve()
						.then(() => provider.flush?.())
						.catch(() => {}),
				),
			);
		},
	};
}

/**
 * The `Logger` dependency of a use case: `dependencies: { logger: Logger }`
 * gives an `ILogger`, the one of the application it runs in.
 */
export interface LoggerDeclaration {
	readonly [Kind]: "logger";
}

export const Logger: LoggerDeclaration = Object.freeze({
	[Kind]: "logger" as const,
});

export function isLoggerDeclaration(
	value: unknown,
): value is LoggerDeclaration {
	return value === Logger;
}

/** Whether `value` can stand for a logger (an override in `execute`). */
export function isLogger(value: unknown): value is ILogger {
	return (
		typeof value === "object" &&
		value !== null &&
		(["debug", "info", "warn", "error"] as const).every(
			(level) =>
				typeof (value as Record<string, unknown>)[level] === "function",
		)
	);
}

/**
 * Carries the logger of an application, when it has a `log`: on the
 * application and on the use case classes it binds.
 */
export const ApplicationLoggerKey: unique symbol = Symbol(
	"afora.application.logger",
);

type LoggerHolder = { readonly [ApplicationLoggerKey]?: ILogger } | undefined;

/**
 * The logger a call writes to: the one its scope carries, else the one of
 * the application its class was bound by, else the started application's.
 */
export function resolveLogger(
	scoped: ILogger | undefined,
	owner: unknown,
): ILogger | undefined {
	return (
		scoped ??
		(owner as LoggerHolder)?.[ApplicationLoggerKey] ??
		(startedApplication() as LoggerHolder)?.[ApplicationLoggerKey]
	);
}

/** Milliseconds, for timing; `Date.now` where there is no `performance`. */
export function clock(): number {
	return globalThis.performance?.now() ?? Date.now();
}

export function elapsed(since: number): number {
	return Math.round(clock() - since);
}

/** The first exception of each failure, so it is logged once however far it goes. */
const logged = new WeakSet<object>();

/**
 * Logs a failure once: the same exception passes through every use case and
 * command up the call, each wrapping it. `warn` for a declared exception,
 * `error` for an unexpected one, with its trace.
 */
export function logFailure(
	logger: ILogger | undefined,
	event: string,
	fields: LogFields,
	error: unknown,
): void {
	if (!logger) return;
	const exception = error instanceof Exception ? error : undefined;
	const key = (exception?.origin ?? error) as object;
	if (typeof key === "object" && key !== null) {
		if (logged.has(key)) return;
		logged.add(key);
	}
	const unexpected = !exception || exception.origin.name === UNEXPECTED_ERROR;
	try {
		logger[unexpected ? "error" : "warn"](event, {
			...fields,
			exception: exception
				? exception.toJSON()
				: { message: error instanceof Error ? error.message : String(error) },
		});
	} catch {
		// Logging is bookkeeping.
	}
}

/** Writes one line; a logger that throws never breaks the call it logs. */
export function writeLog(
	logger: ILogger | undefined,
	level: LogLevel,
	event: string,
	fields: LogFields,
): void {
	if (!logger) return;
	try {
		logger[level](event, fields);
	} catch {
		// Logging is bookkeeping.
	}
}
