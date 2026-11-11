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
