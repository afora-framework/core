import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "high";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOptions {
	readonly model: string;
	readonly effort: Effort;
}

/** `--model` / `AFORA_EVAL_MODEL`, `--effort` / `AFORA_EVAL_EFFORT`. */
export function modelOptions(values: {
	model?: string;
	effort?: string;
}): ModelOptions {
	const effort = (values.effort ??
		process.env.AFORA_EVAL_EFFORT ??
		DEFAULT_EFFORT) as Effort;
	if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
		throw new Error(`Unknown effort "${effort}".`);
	}
	return {
		model: values.model ?? process.env.AFORA_EVAL_MODEL ?? DEFAULT_MODEL,
		effort,
	};
}

/**
 * A client, or a clear exit when there is no key: the scripts never pretend
 * to have run a model.
 */
export function clientOrExit(script: string): Anthropic {
	if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
		console.error(
			`${script}: ANTHROPIC_API_KEY is not set, so no model can be called and nothing was run.\n` +
				"Set it (or ANTHROPIC_AUTH_TOKEN) and run again. The committed runs are listed in README.md.",
		);
		process.exit(1);
	}
	return new Anthropic();
}

/** The parameters every request of the scripts shares. */
export function baseParams(options: ModelOptions) {
	return {
		model: options.model,
		max_tokens: 64000,
		thinking: { type: "adaptive" as const },
		output_config: { effort: options.effort },
		// a refusal is answered again by the model the API picks for its category
		betas: ["server-side-fallback-2026-07-01"],
		fallbacks: "default" as const,
		cache_control: { type: "ephemeral" as const },
	};
}

/** A directory name for the runs of one invocation: `2026-11-10T21-04-05-1`. */
export function runNames(count: number, now = new Date()): string[] {
	const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
	return Array.from({ length: count }, (_, index) => `${stamp}-${index + 1}`);
}
