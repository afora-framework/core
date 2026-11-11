# A custom stage and sink

You want to change the operations of an output (rename, tag, drop some) or build something from them that is not HTTP or OpenAPI.

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	operationOf,
	outputOf,
	repositoryOf,
	resourceOf,
	transformOf,
} from "@afora/core";
import { sinkOf } from "@afora/core/adapters";

class Task extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ change: ["title"] },
) {}
const Tasks = repositoryOf({
	entity: Task,
	actions: ["findById", "findPage", "create", "update", "delete"],
});
const Todo = commandOf({
	name: "Todo",
	useCases: resourceOf(Tasks, { path: "/tasks" }),
});

// A transform changes or drops operations: null removes one
export const label = transformOf({
	name: "label",
	apply: (operation, options: { prefix: string }) =>
		operationOf(operation, {
			meta: { ...operation.meta, label: `${options.prefix}${operation.id}` },
		}),
});

// A sink is the last stage and builds something with what is left
export const listing = sinkOf({
	name: "listing",
	build: (operations, _options: Record<string, never>, { output }) => ({
		output: output.name,
		labels: operations.map((operation) => operation.meta.label),
	}),
});

export const Listed = outputOf({
	name: "Listed",
	commands: [Todo],
	pipe: [label({ prefix: "todo:" }), listing()],
});
```

An output turns commands into operations and runs them through a pipe. A transform (`transformOf`) is called for each operation and returns it, a changed copy (`operationOf` patches `meta`, `tags`, `description`, `deprecated` and `invoke`), or `null` to drop it. A sink (`sinkOf`, from `@afora/core/adapters`) is the last stage: it gets what is left and builds the result, which `Listed.build()` gives. Both are factories, so a stage is a name plus JSON options, and `app.describe()` can write it down.

A sink that serves requests should not parse them itself: `compileRoutes` gives the route table, and `statusOf`, `problemOf` and `outputValueOf` give the status, the problem body and the masked values.

More: [Outputs](../outputs.md), [HTTP providers](../providers.md) (writing one), [Commands](../commands.md).
