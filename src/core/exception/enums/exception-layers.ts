/** The layer of the application an exception was raised or passed through. */
export enum ExceptionLayers {
	Schema = "schema",
	Property = "property",
	Blueprint = "blueprint",
	Record = "record",
	Entity = "entity",
	UseCase = "use-case",
	Repository = "repository",
	/** The variables of the environment, as `environmentOf` reads them. */
	Environment = "environment",
	Event = "event",
	Command = "command",
	/** The declarations of an application, as `applicationOf` gathers them. */
	Application = "application",
	/** Any way out of the application: HTTP, STDIO, a queue, ... */
	Output = "output",
}
