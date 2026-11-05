import { spawn } from "node:child_process";

export interface RunResult {
	readonly code: number | null;
	readonly output: string;
	/** The command could not be started. */
	readonly missing: boolean;
	readonly timedOut: boolean;
}

/** Runs a command, collecting stdout and stderr; never rejects. */
export function run(
	command: string,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number },
): Promise<RunResult> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: null, output, missing: true, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output, missing: false, timedOut });
		});
	});
}
