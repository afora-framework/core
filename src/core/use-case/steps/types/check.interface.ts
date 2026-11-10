/**
 * The compile-time checking of `useCaseOf({ steps })`: the steps are inferred
 * as a tuple and folded in order. Each step sees the values in scope (the
 * input, the context, the environments and the names bound by the earlier
 * steps with `as`); its references must name a path of one of them, and its
 * `args`, `values`, `value` or `input` must fit what the called function,
 * record, repository or use case takes. A reference that does not fit is
 * replaced by the references that would, which is the error TypeScript shows
 * and what the editor offers inside a `"$…"` string.
 *
 * The list of the paths of the scope is computed only for a reference that
 * does not fit, so that right steps cost little to check. The conditionals on
 * the steps are not distributive (`[Step] extends [...]`): TypeScript then
 * never evaluates them with the constraint of the steps while it infers them.
 */
import type {
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
} from "../../../blueprint/types/blueprint.interface";
import type {
	AnyEnvironment,
	EnvironmentValue,
} from "../../../environment/environment";
import type { Meta } from "../../../symbols/meta";
import type {
	AnyUseCaseClass,
	UseCaseInput,
	UseCaseResponse,
} from "../../use-case";

/** The values the first step can reference: the input, the context (if declared) and the environments. */
export type StepsInitialScope<
	Input extends IBlueprintCollection,
	Context extends IBlueprintCollection | undefined,
	Dependencies,
> = {
	readonly input: BlueprintValue<Input>;
	readonly env: {
		readonly [Key in keyof Dependencies as Dependencies[Key] extends AnyEnvironment
			? Key
			: never]: Dependencies[Key] extends AnyEnvironment
			? EnvironmentValue<Dependencies[Key]>
			: never;
	};
} & (Context extends IBlueprintCollection
	? { readonly context: BlueprintValue<Context> }
	: unknown);

// ---------------------------------------------------------------- references

type Split<Path extends string> = Path extends `${infer Head}.${infer Tail}`
	? [Head, ...Split<Tail>]
	: [Path];

/** `Value[Key]` for a value that is not `null` or `undefined`: by index in a list; `never` when absent. */
type GetDefined<Value, Key extends string> = Value extends readonly unknown[]
	? Key extends `${number}`
		? Key extends keyof Value
			? Value[Key]
			: Value[number]
		: never
	: Key extends keyof Value
		? Value[Key]
		: never;

/**
 * `Value[Key]` as `followPath` reads it: `undefined` through a value that
 * may be `undefined` or `null`, and `never` when no value of the type has
 * the key; `unknown` stays `unknown`.
 */
type Get<Value, Key extends string> = unknown extends Value
	? unknown
	: [GetDefined<NonNullable<Value>, Key>] extends [infer Found]
		? [Found] extends [never]
			? never
			: Found | (Value extends null | undefined ? undefined : never)
		: never;

type Walk<Value, Path extends readonly string[]> = Path extends readonly [
	infer Key extends string,
	...infer Rest extends string[],
]
	? Walk<Get<Value, Key>, Rest>
	: Value;

/** The type of the value the reference `$root.a.b` stands for in `Scope`; `never` when it names nothing. */
export type StepReferenceType<Scope, Reference> = [Reference] extends [
	`$${infer Path}`,
]
	? Split<Path> extends [
			infer Root extends string,
			...infer Rest extends string[],
		]
		? Root extends "env"
			? Rest extends [string, ...string[]]
				? Walk<Get<Scope, Root>, Rest>
				: never
			: Walk<Get<Scope, Root>, Rest>
		: never
	: never;

/** What a path walks into: the value of a record, not its methods. */
type DataOf<Value> = Value extends {
	readonly [Meta]: { readonly blueprint: IBlueprint<infer Properties> };
}
	? BlueprintValue<Properties>
	: Value;

type Leaf =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| Date
	| readonly unknown[]
	// biome-ignore lint/suspicious/noExplicitAny: any function
	| ((...args: any[]) => unknown);

type Below<
	Value,
	Prefix extends string,
	Expected,
	Depth extends unknown[],
> = Depth["length"] extends 3
	? never
	: DataOf<NonNullable<Value>> extends infer Data
		? Data extends Leaf
			? never
			: {
					[Key in keyof Data & string]-?: PathsFrom<
						Data[Key] | (Value extends null | undefined ? undefined : never),
						`${Prefix}.${Key}`,
						Expected,
						[...Depth, 0]
					>;
				}[keyof Data & string]
		: never;

// The conditionals on `Path` and `Scope` keep the union from being shown
// under the name of the alias.
type PathsFrom<
	Value,
	Path extends string,
	Expected,
	Depth extends unknown[],
> = Path extends unknown
	?
			| ([Value] extends [Expected] ? Path : never)
			| Below<Value, Path, Expected, Depth>
	: never;

/** Every reference of `Scope` whose value fits `Expected` (three keys deep at most). */
export type StepReferencesOf<Scope, Expected = unknown> = Scope extends unknown
	? {
			[Root in keyof Scope & string]-?: Root extends "env"
				? Below<Scope[Root], `$${Root}`, Expected, [0]>
				: PathsFrom<Scope[Root], `$${Root}`, Expected, []>;
		}[keyof Scope & string]
	: never;

/** `Reference` when it names a value of `Scope` that fits `Expected`; else the references that would. */
type CheckReference<Reference, Expected, Scope> = [
	StepReferenceType<Scope, Reference>,
] extends [infer Type]
	? [Type] extends [never]
		? StepReferencesOf<Scope, Expected>
		: [Type] extends [Expected]
			? Reference
			: StepReferencesOf<Scope, Expected>
	: never;

// -------------------------------------------------------------------- values

type Primitive = string | number | boolean | null;

/** The type of the key `Key` in what `Expected` takes, over each object of it. */
type ExpectedAt<Expected, Key> = Expected extends object
	? Key extends keyof Expected
		? Expected[Key]
		: never
	: never;

/** The keys `Expected` takes in a mapping. */
type KnownKeys<Expected> = Expected extends object ? keyof Expected : never;

/** The keys the plain objects of `Expected` require (a record instance is not built from a mapping). */
type RequiredKeys<Expected> = Expected extends { readonly [Meta]: unknown }
	? never
	: Expected extends object
		? {
				[Key in keyof Expected]-?: undefined extends Expected[Key]
					? never
					: Key;
			}[keyof Expected]
		: never;

/** The keys of `Value` that `Expected` takes, each checked; the others are excess properties. */
// The conditional keeps the mapping from being shown under the name of the alias.
type CheckKeys<Value, Expected, Scope> = Value extends unknown
	? {
			readonly [Key in keyof Value as Key extends KnownKeys<Expected>
				? Key
				: never]: StepValueCheck<Value[Key], ExpectedAt<Expected, Key>, Scope>;
		}
	: never;

type CheckMapping<Value, Expected, Scope> = unknown extends Expected
	? {
			readonly [Key in keyof Value]: StepValueCheck<Value[Key], unknown, Scope>;
		}
	: [Exclude<RequiredKeys<Expected>, keyof Value>] extends [never]
		? CheckKeys<Value, Expected, Scope>
		: CheckKeys<Value, Expected, Scope> & {
				readonly [Key in Exclude<
					RequiredKeys<Expected>,
					keyof Value
				>]: ExpectedAt<Expected, Key>;
			};

type ElementAt<Expected, Index> = unknown extends Expected
	? unknown
	: Expected extends readonly unknown[]
		? Index extends keyof Expected
			? Expected[Index]
			: Expected[number]
		: never;

/**
 * What the step value `Value` must be where `Expected` is taken: itself when
 * it fits; else, for a reference, the references that would fit, and for a
 * literal, `Expected`. A mapping is checked key by key, a list item by item.
 */
export type StepValueCheck<Value, Expected, Scope> = [Value] extends [
	`$${string}`,
]
	? CheckReference<Value, Expected, Scope>
	: [Value] extends [Primitive]
		? [Value] extends [Expected]
			? Value
			: Expected
		: [Value] extends [{ readonly literal: unknown }]
			? Value
			: [Value] extends [readonly unknown[]]
				? {
						readonly [Index in keyof Value]: StepValueCheck<
							Value[Index],
							ElementAt<Expected, Index>,
							Scope
						>;
					}
				: [Value] extends [object]
					? CheckMapping<Value, Expected, Scope>
					: Value;

/** The parameter `Index` of a function whose parameters are `Parameters`. */
type ParameterAt<
	Parameters extends readonly unknown[],
	Index,
> = Index extends keyof Parameters
	? Parameters[Index]
	: number extends Parameters["length"]
		? Parameters[number]
		: undefined;

/** What the `args` of a call must be: each against its parameter, or one reference to a list. */
type CheckArgs<Args, Parameters extends readonly unknown[], Scope> = [
	Args,
] extends [`$${string}`]
	? CheckReference<Args, readonly unknown[], Scope>
	: {
			readonly [Index in keyof Args]: StepValueCheck<
				Args[Index],
				ParameterAt<Parameters, Index>,
				Scope
			>;
		};

// --------------------------------------------------------------------- steps

// biome-ignore lint/suspicious/noExplicitAny: any function
type Fn = (...args: any[]) => unknown;

type ParametersOf<Value> = [Value] extends [Fn] ? Parameters<Value> : unknown[];
type FirstParameter<Value> = [Value] extends [never]
	? unknown
	: [Value] extends [Fn]
		? Parameters<Value>[0]
		: unknown;
type ResultOf<Value> = [Value] extends [Fn]
	? Awaited<ReturnType<Value>>
	: unknown;

/** `Dependencies[Key][Member]`, or `unknown`. */
type MemberOf<Dependencies, Key, Member> = Key extends keyof Dependencies
	? Member extends keyof Dependencies[Key]
		? Dependencies[Key][Member]
		: unknown
	: unknown;

/** The method `"users.findByEmail"` names among `Dependencies`. */
type FindMethod<Dependencies, Target> =
	Target extends `${infer Repository}.${infer Action}`
		? MemberOf<Dependencies, Repository, Action>
		: unknown;

/** The members of a record no `invoke` may call. */
type ForbiddenMethod =
	| "set"
	| "emit"
	| "constructor"
	| "toLocaleString"
	| "valueOf"
	| "hasOwnProperty"
	| "isPrototypeOf"
	| "propertyIsEnumerable";

/** The public methods of the record `Record`: what `invoke.method` names. */
type StepInvokeMethod<Record> = Record extends unknown
	? {
			[Key in keyof Record & string]-?: Record[Key] extends Fn ? Key : never;
		}[Exclude<keyof Record & string, ForbiddenMethod>]
	: never;

type ChangeOf<Record> = Record extends { readonly change: infer Change }
	? Change
	: never;

type UseCaseOf<Dependencies, Key> = Key extends keyof Dependencies
	? Dependencies[Key] extends AnyUseCaseClass
		? Dependencies[Key]
		: never
	: never;

/** A step that calls `Method` with its `args`: `[checked step, result]`. */
type CallStep<Step, Method, Scope> = [
	{
		readonly [Key in keyof Step]: Key extends "args"
			? CheckArgs<Step[Key], ParametersOf<Method>, Scope>
			: Step[Key];
	},
	ResultOf<Method>,
];

/** A step whose `Field` is checked against `Expected`: `[checked step, result]`. */
type ValueStep<Step, Field, Expected, Result, Scope> = [
	{
		readonly [Key in keyof Step]: Key extends Field
			? StepValueCheck<Step[Key], Expected, Scope>
			: Step[Key];
	},
	Result,
];

type InvokeStep<Step, Record, Scope> = [Record] extends [never]
	? ValueStep<Step, "invoke", object, unknown, Scope>
	: [Step] extends [{ readonly method: infer Method }]
		? Method extends keyof Record
			? CallStep<Step, Record[Method], Scope>
			: [
					{
						readonly [Key in keyof Step]: Key extends "method"
							? StepInvokeMethod<Record>
							: Step[Key];
					},
					unknown,
				]
		: [Step, unknown];

type ChangeStep<Step, Record, Scope> = [Record] extends [never]
	? ValueStep<Step, "change", object, unknown, Scope>
	: [Step] extends [{ readonly key: infer Name }]
		? Name extends keyof ChangeOf<Record>
			? ValueStep<
					Step,
					"value",
					FirstParameter<ChangeOf<Record>[Name]>,
					Record,
					Scope
				>
			: [
					{
						readonly [Key in keyof Step]: Key extends "key"
							? keyof ChangeOf<Record> & string
							: Step[Key];
					},
					Record,
				]
		: [Step, Record];

/** `[what Step must be, what it gives to its as]`, read against `Scope`. */
type CheckStep<Step, Dependencies, Scope> = [Step] extends [
	{ readonly find: infer Target },
]
	? CallStep<Step, FindMethod<Dependencies, Target>, Scope>
	: [Step] extends [{ readonly run: unknown; readonly fn: infer Run }]
		? CallStep<Step, Run, Scope>
		: [Step] extends [{ readonly invoke: infer Reference }]
			? InvokeStep<
					Step,
					NonNullable<StepReferenceType<Scope, Reference>>,
					Scope
				>
			: [Step] extends [{ readonly change: infer Reference }]
				? ChangeStep<
						Step,
						NonNullable<StepReferenceType<Scope, Reference>>,
						Scope
					>
				: [Step] extends [
							{
								readonly build: abstract new (
									value: infer Input,
								) => infer Built;
							},
						]
					? ValueStep<Step, "values", Input, Built, Scope>
					: [Step] extends [{ readonly call: infer Name }]
						? ValueStep<
								Step,
								"input",
								UseCaseInput<UseCaseOf<Dependencies, Name>>,
								UseCaseResponse<UseCaseOf<Dependencies, Name>>,
								Scope
							>
						: [Step] extends [{ readonly create: infer Repository }]
							? WriteStep<
									Step,
									MemberOf<Dependencies, Repository, "create">,
									Scope
								>
							: [Step] extends [{ readonly update: infer Repository }]
								? WriteStep<
										Step,
										MemberOf<Dependencies, Repository, "update">,
										Scope
									>
								: [Step] extends [{ readonly delete: infer Repository }]
									? WriteStep<
											Step,
											MemberOf<Dependencies, Repository, "delete">,
											Scope
										>
									: [Step] extends [{ readonly restore: infer Repository }]
										? WriteStep<
												Step,
												MemberOf<Dependencies, Repository, "restore">,
												Scope
											>
										: // ensure and return: references only
											ValueStep<
												Step,
												"value" | "other" | "details" | "return",
												unknown,
												unknown,
												Scope
											>;

type WriteStep<Step, Method, Scope> = ValueStep<
	Step,
	"value",
	FirstParameter<Method>,
	ResultOf<Method>,
	Scope
>;

/** The scope after `Step`: its result bound to its `as`, or a value it ensures exists. */
type ScopeAfter<Step, Result, Scope> = [Step] extends [
	{ readonly as: infer Name extends string },
]
	? Scope & { readonly [Key in Name]: Result }
	: [Step] extends [
				{ readonly ensure: "exists"; readonly value: `$${infer Name}` },
			]
		? Name extends keyof Scope
			? Scope & { readonly [Key in Name]: NonNullable<Scope[Name]> }
			: Scope
		: Scope;

/** The steps folded in order, each checked against the scope the earlier ones built. */
type CheckSteps<
	Steps extends readonly unknown[],
	Dependencies,
	Scope,
	Checked extends readonly unknown[] = [],
> = [Steps] extends [readonly [infer Step, ...infer Rest]]
	? CheckStep<Step, Dependencies, Scope> extends [infer Current, infer Result]
		? CheckSteps<
				Rest,
				Dependencies,
				ScopeAfter<Step, Result, Scope>,
				[...Checked, Current]
			>
		: never
	: readonly [...Checked];

/**
 * What `useCaseOf` takes as `steps`: the steps, inferred as a tuple, each
 * checked against the values in scope. Steps that are not a tuple (built at
 * run time) are checked only when the use case is declared.
 */
export type CheckedSteps<
	Steps,
	Input extends IBlueprintCollection,
	Context extends IBlueprintCollection | undefined,
	Dependencies,
> = [Steps] extends [readonly [unknown, ...unknown[]]]
	? CheckSteps<
			Steps,
			Dependencies,
			StepsInitialScope<Input, Context, Dependencies>
		>
	: Steps;
