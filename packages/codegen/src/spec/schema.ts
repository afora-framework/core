import { type TSchema, Type } from "typebox";

const NAME = "^[A-Z][A-Za-z0-9]*$";
const IMPORT = "^[^#\\s]+#[A-Za-z_$][A-Za-z0-9_$]*$";
const KEY = "^[A-Za-z_$][A-Za-z0-9_$]*$";
const PROVIDER_KEY = "^[a-z][A-Za-z0-9]*$";

const Bounds = Type.Object(
	{
		minItems: Type.Optional(Type.Integer({ minimum: 0 })),
		maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false, description: "Bounds of a list." },
);

const Modifiers = {
	optional: Type.Optional(
		Type.Boolean({ description: "The key may be absent." }),
	),
	list: Type.Optional(
		Type.Union([Type.Boolean(), Bounds], {
			description:
				"A list of the type (the options in `with` apply to each item). `true` or { minItems, maxItems }.",
		}),
	),
};

const EnumValues = Type.Array(Type.Union([Type.String(), Type.Number()]), {
	minItems: 1,
	uniqueItems: true,
});

const WithOptions = Type.Record(Type.String(), Type.Unknown(), {
	description:
		"Options of the property: title, description, examples, deprecated, readOnly, writeOnly, default; min, max, pattern for strings; min, max, exclusiveMin, exclusiveMax, multipleOf for numbers. See afora_catalog for what each property takes.",
});

const FieldRef = Type.Ref("#/$defs/Field");

const FieldsOf = Type.Record(Type.String({ pattern: KEY }), FieldRef, {
	additionalProperties: false,
	description: "Fields by key.",
});

/** A field: shorthand string, or the object form. */
export const fieldDefinition = Type.Union(
	[
		Type.String({
			pattern: "^[A-Za-z][A-Za-z0-9]*(\\[\\])?\\??$",
			description:
				'Shorthand: a Std property ("email"), a declaration ("Address"), "Age?" for optional, "string[]" for a list, "User[]?" for an optional list.',
		}),
		Type.Object(
			{
				type: Type.String({
					pattern: "^[A-Za-z][A-Za-z0-9]*$",
					description:
						"A Std property (lowercase: email, text, integer...) or a declaration of this spec (PascalCase).",
				}),
				with: Type.Optional(WithOptions),
				...Modifiers,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				enum: EnumValues,
				name: Type.Optional(Type.String()),
				default: Type.Optional(Type.Union([Type.String(), Type.Number()])),
				...Modifiers,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ fields: FieldsOf, ...Modifiers },
			{
				additionalProperties: false,
				description: "A nested object, declared in place.",
			},
		),
	],
	{ description: "A field of a blueprint, record, entity or environment." },
);

const Fields = FieldsOf;

const Names = (schema: TSchema, description: string) =>
	Type.Record(Type.String({ pattern: NAME }), schema, {
		additionalProperties: false,
		description,
	});

const Property = Type.Union(
	[
		Type.Object(
			{
				base: Type.String({
					description:
						"A Std property (lowercase) or another declared property.",
				}),
				with: Type.Optional(WithOptions),
				optional: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				enum: EnumValues,
				name: Type.Optional(Type.String()),
				default: Type.Optional(Type.Union([Type.String(), Type.Number()])),
				optional: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				opaque: Type.Literal(true),
				ref: Type.Optional(
					Type.String({
						description: "The exported name; the declared name by default.",
					}),
				),
				import: Type.String({
					description:
						"The module it is exported from, relative to the output directory.",
				}),
			},
			{ additionalProperties: false },
		),
	],
	{
		description:
			"A custom property: `base` + `with` (a refined Std property), an `enum`, or an `opaque` import of a hand-written property.",
	},
);

const ImportRef = Type.Object(
	{
		import: Type.String({
			pattern: IMPORT,
			description:
				'A hand-written export: "./file.ts#name" or "package#name", relative to the output directory. Never evaluated by the validator.',
		}),
	},
	{ additionalProperties: false },
);

const OptionValue = Type.Union(
	[
		Type.String(),
		Type.Number(),
		Type.Boolean(),
		Type.Null(),
		ImportRef,
		Type.Array(Type.Unknown()),
		Type.Record(Type.String(), Type.Unknown()),
	],
	{
		description:
			'A JSON value, or { "import": "./file.ts#name" } for a value created by hand (nested at any depth).',
	},
);

const ProviderForms = [
	Type.Literal("inMemory"),
	Type.Object(
		{
			use: Type.String({
				description:
					"A provider of the catalog given to codegen (inMemory is built in).",
			}),
			options: Type.Optional(
				Type.Record(Type.String(), OptionValue, {
					description: "Options passed to the provider factory.",
				}),
			),
		},
		{ additionalProperties: false },
	),
	ImportRef,
] as const;

const Provider = Type.Union([...ProviderForms], {
	description:
		'"inMemory", { "use": "<catalog name>", "options": {...} } or { "import": "./file.ts#provider" }.',
});

const ProviderKey = Type.String({
	pattern: PROVIDER_KEY,
	description:
		'A key of the top-level "providers" (camelCase; "inMemory" is the built-in provider).',
});

const ProviderOrKey = Type.Union([...ProviderForms, ProviderKey], {
	description:
		'"inMemory", { "use": ... }, { "import": ... }, or a key of the top-level "providers", e.g. "audit".',
});

const Providers = Type.Record(
	Type.String({ pattern: PROVIDER_KEY }),
	Provider,
	{
		description:
			'Named providers, by camelCase key (generated as `Providers` with providersOf): a repository or the application names one with "provider": "<key>".',
	},
);

const Log = Type.Union(
	[
		Type.Object(
			{
				level: Type.Optional(
					Type.Union(
						[
							Type.Literal("debug"),
							Type.Literal("info"),
							Type.Literal("warn"),
							Type.Literal("error"),
						],
						{ description: "The lowest level kept; info by default." },
					),
				),
				providers: Type.Array(
					Type.Union([
						Type.Literal("console"),
						Type.Literal("json"),
						ImportRef,
					]),
					{
						description:
							'Where the lines go: "console", "json" or { "import": "./file.ts#provider" }.',
					},
				),
			},
			{ additionalProperties: false },
		),
		ImportRef,
	],
	{
		description:
			'How the application logs: { "level", "providers" }, or { "import": "./file.ts#log" } for a log made by hand (logFrom).',
	},
);

const StringList = (description: string) =>
	Type.Array(Type.String(), { description });

const RecordDeclaration = Type.Object(
	{
		fields: Fields,
		sensitive: Type.Optional(
			StringList(
				"Keys always masked by toJSON(); `password` properties already are.",
			),
		),
		unique: Type.Optional(
			StringList(
				"Keys that are unique (repositories get findBy<Key>); `slug` properties already are.",
			),
		),
		change: Type.Optional(
			StringList("Keys that get a change.<key>(value) method."),
		),
		plugins: Type.Optional(
			StringList(
				"Std record plugins: publishable, archivable, taggable, ownable, authenticatable.",
			),
		),
	},
	{ additionalProperties: false },
);

const RepositoryDeclaration = Type.Object(
	{
		entity: Type.String({ description: "The entity it stores." }),
		deletion: Type.Optional(
			Type.Union([Type.Literal("hard"), Type.Literal("soft")], {
				default: "hard",
				description: "Physical removal or retained rows hidden by deletedAt.",
			}),
		),
		actions: Type.Array(Type.String(), {
			description:
				"findById, findBy<Key> (unique keys), findManyBy<Key> (other keys), findMany, exists, findPage, findCursor, create, update, delete, count.",
		}),
		provider: Type.Optional(ProviderOrKey),
		relations: Type.Optional(
			StringList(
				"Repositories of every entity the entity holds, at any depth.",
			),
		),
		environments: Type.Optional(StringList("Environments it depends on.")),
	},
	{ additionalProperties: false },
);

const BlueprintRef = Type.Union(
	[
		Type.String({
			pattern: NAME,
			description: "The name of a declared blueprint.",
		}),
		Type.Object({ fields: Fields }, { additionalProperties: false }),
	],
	{
		description:
			'A blueprint by name ("RegisterInput") or declared in place ({ "fields": {...} }).',
	},
);

const Exception = Type.Object(
	{
		layer: Type.String({
			description:
				"One of the exception layers: schema, property, blueprint, record, entity, use-case, repository, environment, event, command, application, output (see afora_catalog).",
		}),
		message: Type.Optional(
			Type.String({ description: 'The message. "<Name>." when omitted.' }),
		),
	},
	{ additionalProperties: false },
);

const StepValue = Type.Unknown({
	description:
		'A value: a "$reference" ($input.key, $context.key, $env.dep.VAR, $name.path), a JSON literal ({ "literal": "$5" } escapes a string that starts with $) or a mapping of values. No expressions.',
});
const StepArgs = Type.Optional(
	Type.Union([Type.Array(StepValue), Type.String({ pattern: "^\\$" })], {
		description:
			'The arguments: a list of values, or one "$reference" to a list, which is spread.',
	}),
);
const StepAs = Type.Optional(Type.String({ description: "Binds the result." }));
const StepErrorRef = Type.Union([
	Type.String(),
	Type.Object({ core: Type.String() }, { additionalProperties: false }),
]);

const Step = Type.Union(
	[
		Type.Object(
			{
				find: Type.String({
					description:
						'"<repository>.<read action>", e.g. "users.findByEmail".',
				}),
				args: StepArgs,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				ensure: Type.Union(
					[
						Type.Literal("exists"),
						Type.Literal("absent"),
						Type.Literal("equals"),
						Type.Literal("notEquals"),
						Type.Literal("true"),
						Type.Literal("false"),
					],
					{ description: "What to check; throws `error` when it fails." },
				),
				value: StepValue,
				other: Type.Optional(StepValue),
				error: StepErrorRef,
				details: Type.Optional(StepValue),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				build: Type.String({ description: "A declared record or entity." }),
				values: StepValue,
				as: Type.String(),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				change: Type.String({ description: "A $reference to a record." }),
				key: Type.String(),
				value: StepValue,
				ifPresent: Type.Optional(
					Type.Boolean({
						description:
							"Skips the step when the value is absent: a partial update.",
					}),
				),
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				invoke: Type.String({ description: "A $reference to a record." }),
				method: Type.String(),
				args: StepArgs,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				create: Type.String({ description: "A repository dependency." }),
				value: StepValue,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				update: Type.String({ description: "A repository dependency." }),
				value: StepValue,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				delete: Type.String({ description: "A repository dependency." }),
				value: StepValue,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				call: Type.String({ description: "A use case dependency." }),
				input: StepValue,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				run: Type.String({ description: "A name, unique in the use case." }),
				fn: ImportRef,
				args: StepArgs,
				as: StepAs,
			},
			{ additionalProperties: false },
		),
		Type.Object({ return: StepValue }, { additionalProperties: false }),
	],
	{
		description:
			"A step: find, ensure, build, change, invoke, create, update, delete, call, run or return (exactly one, last).",
	},
);

const UseCaseDeclaration = Type.Object(
	{
		description: Type.Optional(Type.String()),
		tags: Type.Optional(StringList("Tags, for documentation.")),
		deprecated: Type.Optional(Type.Boolean({ default: false })),
		input: BlueprintRef,
		response: BlueprintRef,
		context: Type.Optional(BlueprintRef),
		dependencies: Type.Optional(
			Type.Record(Type.String({ pattern: KEY }), Type.String(), {
				description:
					"Key -> name of a declared use case, repository or environment.",
			}),
		),
		errors: Type.Optional(
			StringList(
				"Declared exceptions, or exceptions exported by @afora/core (afora_catalog coreExceptions), a caller should expect.",
			),
		),
		implementation: Type.Union(
			[
				Type.Object(
					{ steps: Type.Array(Step, { minItems: 1 }) },
					{ additionalProperties: false },
				),
				ImportRef,
			],
			{
				description:
					'{ "steps": [...] } (complete, no hand-written file) or { "import": "./file.ts#Class" } (a class extending the generated <Name>Base).',
			},
		),
	},
	{ additionalProperties: false },
);

const CommandDeclaration = Type.Object(
	{
		description: Type.Optional(Type.String()),
		tags: Type.Optional(StringList("Tags, for documentation.")),
		context: Type.Optional(BlueprintRef),
		useCases: Type.Record(Type.String({ pattern: KEY }), Type.String(), {
			minProperties: 1,
			description:
				'Operation name -> name of a declared use case (e.g. { "register": "Register" }).',
		}),
		transaction: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					"Runs every call in a transaction of the provider of the repositories (checked when the code runs: the provider must support it).",
			}),
		),
		environments: Type.Optional(
			StringList(
				"Environments it depends on: command.env, the event handlers and the use cases that declare them get their variables.",
			),
		),
		events: Type.Optional(
			Type.Union(
				[Type.Literal("after-commit"), Type.Literal("manual"), ImportRef],
				{
					default: "after-commit",
					description:
						'"after-commit" (default), "manual" or { "import": "./events.ts#dispatch" } (a handler written by hand).',
				},
			),
		),
		onEventError: Type.Optional(ImportRef),
	},
	{ additionalProperties: false },
);

const StageOptions = Type.Record(Type.String(), Type.Unknown(), {
	description: "JSON options of the stage factory.",
});

const PipeEntry = Type.Union(
	[
		Type.Object(
			{
				transform: Type.String({
					description:
						"A transform of the stage catalog (afora_catalog stages).",
				}),
				options: Type.Optional(StageOptions),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				sink: Type.String({
					description: "A sink of the stage catalog; only the last stage.",
				}),
				options: Type.Optional(StageOptions),
			},
			{ additionalProperties: false },
		),
		ImportRef,
	],
	{
		description:
			'{ "transform": name, "options"? }, { "sink": name, "options"? } or { "import": "./stages.ts#auth" } (a stage written by hand).',
	},
);

const OutputDeclaration = Type.Object(
	{
		commands: Type.Array(Type.String({ pattern: NAME }), {
			minItems: 1,
			uniqueItems: true,
			description: "Names of declared commands.",
		}),
		statuses: Type.Optional(
			Type.Record(Type.String(), Type.Integer({ minimum: 400, maximum: 599 }), {
				description:
					"HTTP-style status by exception name (declared or exported by @afora/core).",
			}),
		),
		pipe: Type.Array(PipeEntry, {
			description: "Transforms, then at most one sink as the last stage.",
		}),
	},
	{ additionalProperties: false },
);

/** The JSON Schema of `afora.json`, version 1. */
export const specSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		version: Type.Literal(1),
		name: Type.Optional(
			Type.String({ description: "The name of the generated application." }),
		),
		extends: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Other specs whose declarations this one uses: relative paths to their afora.json, or package names.",
			}),
		),
		output: Type.Optional(
			Type.Object(
				{
					dir: Type.String({
						description:
							"Where the code is generated, relative to the project. src/domain by default.",
					}),
				},
				{ additionalProperties: false },
			),
		),
		provider: Type.Optional(ProviderOrKey),
		providers: Type.Optional(Providers),
		log: Type.Optional(Log),
		properties: Type.Optional(
			Names(Property, "Custom properties, by PascalCase name."),
		),
		blueprints: Type.Optional(
			Names(
				Type.Object({ fields: Fields }, { additionalProperties: false }),
				"Object shapes without identity, by name.",
			),
		),
		records: Type.Optional(
			Names(RecordDeclaration, "Value objects (records), by name."),
		),
		entities: Type.Optional(
			Names(
				RecordDeclaration,
				"Entities (a record plus id, createdAt, updatedAt, deletedAt), by name.",
			),
		),
		environments: Type.Optional(
			Names(
				Type.Object({ fields: Fields }, { additionalProperties: false }),
				"Environment variables, read from process.env, by name.",
			),
		),
		repositories: Type.Optional(
			Names(RepositoryDeclaration, "Repositories of entities, by name."),
		),
		exceptions: Type.Optional(
			Names(Exception, "Exceptions (exceptionOf), by name."),
		),
		useCases: Type.Optional(Names(UseCaseDeclaration, "Use cases, by name.")),
		commands: Type.Optional(
			Names(CommandDeclaration, "Commands (commandOf), by name."),
		),
		outputs: Type.Optional(
			Names(OutputDeclaration, "Outputs (outputOf), by name."),
		),
	},
	{
		additionalProperties: false,
		title: "afora.json",
		$defs: { Field: fieldDefinition },
	},
);

/** The schema of one declaration, by kind (as `afora_spec_upsert` takes it). */
export const declarationSchemas = {
	property: Property,
	blueprint: Type.Object({ fields: Fields }, { additionalProperties: false }),
	record: RecordDeclaration,
	entity: RecordDeclaration,
	environment: Type.Object({ fields: Fields }, { additionalProperties: false }),
	repository: RepositoryDeclaration,
	exception: Exception,
	useCase: UseCaseDeclaration,
	command: CommandDeclaration,
	output: OutputDeclaration,
} as const;
