import type { FieldsDescription } from "../../../application/types/application.interface";
import type {
	AnyBlueprint,
	AnyRecordClass,
} from "../../../blueprint/types/blueprint.interface";
import type { AnyRepository } from "../../../repository/types/repository.interface";
import type {
	AnyExceptionClass,
	AnyUseCaseClass,
	UseCaseCollection,
} from "../../use-case";

/** A reference to a value: `$input.email`, `$context.userId`, `$env.mail`, `$saved.tags.0`. */
export type StepReference = `$${string}`;

/**
 * A value of a step: a reference, a JSON literal (`{ literal: x }` for a
 * string that starts with `$`) or a mapping of values. Checked at execution.
 */
export type StepValue =
	| StepReference
	| string
	| number
	| boolean
	| null
	| readonly StepValue[]
	| { readonly [key: string]: StepValue };

/**
 * The arguments of a `find`, `invoke` or `run`: a list of values, or one
 * reference to a list, which is spread (`args: "$input.tags"`).
 */
export type StepArgs = readonly StepValue[] | StepReference;

/** The actions of a repository that only read. */
export type StepReadAction =
	| `findBy${string}`
	| `findManyBy${string}`
	| "findMany"
	| "exists"
	| "findPage"
	| "findCursor"
	| "count";

type RepositoryKeys<Dependencies> = {
	[Key in keyof Dependencies & string]: Dependencies[Key] extends AnyRepository
		? Key
		: never;
}[keyof Dependencies & string];

type UseCaseKeys<Dependencies> = {
	[Key in keyof Dependencies &
		string]: Dependencies[Key] extends AnyUseCaseClass ? Key : never;
}[keyof Dependencies & string];

type ActionsOf<Repository> = Repository extends {
	readonly actions: readonly (infer Action)[];
}
	? Action
	: never;

/** `"users.findByEmail"`: a repository dependency and one of its read actions. */
export type StepFindTarget<Dependencies> = {
	[Key in RepositoryKeys<Dependencies>]: `${Key}.${Extract<ActionsOf<Dependencies[Key]>, StepReadAction>}`;
}[RepositoryKeys<Dependencies>];

/** The repository dependencies that have the action `Action`. */
export type StepRepositoryWith<Dependencies, Action extends string> = {
	[Key in RepositoryKeys<Dependencies>]: Action extends ActionsOf<
		Dependencies[Key]
	>
		? Key
		: never;
}[RepositoryKeys<Dependencies>];

/** What an `ensure` checks. */
export type StepEnsureKind =
	| "exists"
	| "absent"
	| "equals"
	| "notEquals"
	| "true"
	| "false";

/**
 * One step of `useCaseOf({ steps })`: plain data, the same in TypeScript and
 * in JSON but for the classes of `build` and `ensure.error` and the function
 * of `run`. TypeScript checks the names of dependencies and actions; the
 * values are checked by the blueprints at execution.
 */
export type UseCaseStep<
	Dependencies extends UseCaseCollection = UseCaseCollection,
> =
	| {
			/** `"<repository>.<read action>"`. */
			readonly find: StepFindTarget<Dependencies>;
			readonly args?: StepArgs;
			readonly as?: string;
	  }
	| {
			readonly ensure: "exists" | "absent" | "true" | "false";
			readonly value: StepValue;
			readonly other?: undefined;
			readonly error: AnyExceptionClass;
			readonly details?: StepValue;
	  }
	| {
			readonly ensure: "equals" | "notEquals";
			readonly value: StepValue;
			readonly other: StepValue;
			readonly error: AnyExceptionClass;
			readonly details?: StepValue;
	  }
	| {
			/** A record or entity class. */
			readonly build: AnyRecordClass;
			readonly values: StepValue;
			readonly as: string;
	  }
	| {
			/** A reference to a record or entity. */
			readonly change: StepReference;
			readonly key: string;
			readonly value: StepValue;
			/** Skips the step when `value` resolves to `undefined`: a partial update. */
			readonly ifPresent?: boolean;
			readonly as?: string;
	  }
	| {
			/** A reference to a record or entity. */
			readonly invoke: StepReference;
			readonly method: string;
			readonly args?: StepArgs;
			readonly as?: string;
	  }
	| {
			readonly create: StepRepositoryWith<Dependencies, "create">;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly update: StepRepositoryWith<Dependencies, "update">;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly delete: StepRepositoryWith<Dependencies, "delete">;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			/** A soft-deleted entity or its id; the repository gives it back alive. */
			readonly restore: StepRepositoryWith<Dependencies, "restore">;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly call: UseCaseKeys<Dependencies>;
			readonly input: StepValue;
			readonly as?: string;
	  }
	| {
			readonly run: string;
			// biome-ignore lint/suspicious/noExplicitAny: any function, validated at execution
			readonly fn: (...args: any[]) => unknown;
			readonly args?: StepArgs;
			/**
			 * Checks the `args` at execution: each against the key of the blueprint
			 * at its position; `fn` gets the values as the keys handled them.
			 */
			readonly params?: AnyBlueprint;
			readonly as?: string;
	  }
	| { readonly return: StepValue };

/** A core exception or one registered in the application, by name. */
export type StepErrorDescription = string | { readonly core: string };

/** A `UseCaseStep` as `describe()` gives it: classes by name, functions as `opaque`. */
export type UseCaseStepDescription =
	| {
			readonly find: string;
			readonly args?: StepArgs;
			readonly as?: string;
	  }
	| {
			readonly ensure: StepEnsureKind;
			readonly value: StepValue;
			readonly other?: StepValue;
			readonly error: StepErrorDescription;
			readonly details?: StepValue;
	  }
	| {
			readonly build: string;
			readonly values: StepValue;
			readonly as: string;
	  }
	| {
			readonly change: string;
			readonly key: string;
			readonly value: StepValue;
			readonly ifPresent?: boolean;
			readonly as?: string;
	  }
	| {
			readonly invoke: string;
			readonly method: string;
			readonly args?: StepArgs;
			readonly as?: string;
	  }
	| {
			readonly create: string;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly update: string;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly delete: string;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| {
			readonly restore: string;
			readonly value: StepValue;
			readonly as?: string;
	  }
	| { readonly call: string; readonly input: StepValue; readonly as?: string }
	| {
			readonly run: string;
			readonly fn: { readonly kind: "opaque" };
			readonly args?: StepArgs;
			readonly params?: FieldsDescription;
			readonly as?: string;
	  }
	| { readonly return: StepValue };
