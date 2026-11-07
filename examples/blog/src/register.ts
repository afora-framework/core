import type { App } from "./domain";

// Types what useApplication() gives anywhere in the blog.
declare module "@afora/core" {
	interface Register {
		application: typeof App;
	}
}
