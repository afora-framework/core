import { snapshot } from "./serialize";

const [entry] = process.argv.slice(2);
if (!entry) throw new Error("Missing execution context");
let count = 0;
for (const level of [
	"log",
	"info",
	"warn",
	"error",
	"debug",
	"dir",
	"table",
] as const) {
	console[level] = (...args: unknown[]) => {
		if (++count > 1000) return;
		process.send?.({
			type: "log",
			level,
			values: args.map((value) => snapshot(value)),
		});
	};
}
try {
	await import(entry);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	// Timers may still emit logs; IPC must not keep an otherwise finished snippet alive.
	process.channel?.unref();
}
