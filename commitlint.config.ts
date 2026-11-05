export default {
	extends: ["@commitlint/config-conventional"],
	// Dependabot writes long changelog lines in its commit bodies.
	ignores: [
		(message: string) => message.includes("Signed-off-by: dependabot[bot]"),
	],
};
