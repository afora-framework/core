import { type TSchema, Type } from "typebox";

const NAME = "^[A-Z][A-Za-z0-9]*$";
const IMPORT = "^[^#\\s]+#[A-Za-z_$][A-Za-z0-9_$]*$";
const KEY = "^[A-Za-z_$][A-Za-z0-9_$]*$";
const PROVIDER_KEY = "^[a-z][A-Za-z0-9]*$";
const PUBLISHER_KEY = "^[A-Za-z_$][A-Za-z0-9_$]*$";

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

/** `fill` and `renamedFrom` of a type or enum field (not a list). */
const Evolution = {
	fill: Type.Optional(
		Type.Unknown({
			description:
				"The value a repository gives the key when a stored row lacks it, on read and in app.migrate; unlike `default` (the demo value), it fills real data. Not for list fields.",
		}),
	),
	renamedFrom: Type.Optional(
		Type.String({
			pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$",
			description:
				"The key that held the value in rows stored before the key was renamed: moved on read and in app.migrate. Not for list fields.",
		}),
	),
};

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
				...Evolution,
				...Modifiers,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				enum: EnumValues,
				name: Type.Optional(Type.String()),
				default: Type.Optional(Type.Union([Type.String(), Type.Number()])),
				...Evolution,
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
		Type.Object(
			{
				variant: Type.Object(
					{
						key: Type.String({
							minLength: 1,
							description:
								"The key whose value names the variant. No variant declares it: the field adds it.",
						}),
						of: Type.Record(
							Type.String(),
							Type.Union([
								Type.String({
									pattern: NAME,
									description:
										"The name of a declared blueprint, record or entity.",
								}),
								Type.Object(
									{ fields: FieldsOf },
									{
										additionalProperties: false,
										description: "A blueprint declared in place.",
									},
								),
							]),
							{
								minProperties: 1,
								description:
									'The variants, by the value the key has for each: { "card": "Card", "pix": "Pix" }.',
							},
						),
					},
					{ additionalProperties: false },
				),
				...Modifiers,
			},
			{
				additionalProperties: false,
				description:
					'One of several objects, told apart by the value of "key" (variantOf): { "variant": { "key": "type", "of": { "click": "Click", "signup": "Signup" } } }.',
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

const EventPolicy = Type.Object(
	{
		policy: Type.String({
			description:
				'The name of an event policy of the catalog: "publishEvents" is built in; others come from the policies given to codegen (--policies).',
		}),
		options: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					'JSON options of the policy. publishEvents: { "publisher": "<key of publishers>", "topic": "posts/{id}", "events"?: [names], "handle"?: true, "onPublishError"?: "log" | "throw" }.',
			}),
		),
	},
	{ additionalProperties: false },
);

const Publishers = Type.Record(
	Type.String({ pattern: PUBLISHER_KEY }),
	ImportRef,
	{
		description:
			'Where event policies publish, by key (applicationOf({ publishers })): a publisher written by hand, { "import": "./realtime.ts#hub" }.',
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

const EntityEvent = Type.Union([
	Type.String({ pattern: KEY, description: "An event without a handler." }),
	Type.Object(
		{
			name: Type.String({ pattern: KEY }),
			handler: Type.Optional(ImportRef),
		},
		{ additionalProperties: false },
	),
]);

const EntityEventList = Type.Union([
	EntityEvent,
	Type.Array(EntityEvent, { minItems: 1 }),
]);

const EntityEvents = Type.Object(
	{
		onCreate: Type.Optional(EntityEventList),
		onUpdate: Type.Optional(EntityEventList),
		onDelete: Type.Optional(EntityEventList),
	},
	{
		additionalProperties: false,
		description:
			'Entities only: the events each cycle raises, generated as <Name>Events with eventOf. An event is a name ("created"), raised for a policy such as publishEvents, or { "name": "created", "handler": { "import": "./events.ts#onCreated" } }.',
	},
);

const DurationAmount = Type.Optional(Type.Number({ exclusiveMinimum: 0 }));

const EntityExpires = Type.Union(
	[
		Type.Object(
			{
				after: Type.Object(
					{
						days: DurationAmount,
						hours: DurationAmount,
						minutes: DurationAmount,
						seconds: DurationAmount,
					},
					{
						additionalProperties: false,
						minProperties: 1,
						description:
							'A duration from createdAt, e.g. { "days": 400 }; the entity gets an expiresAt identity key.',
					},
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				at: Type.String({
					description:
						"A date field (dateTime or date, optional or not) holding when the record expires; without a value it never does.",
				}),
			},
			{ additionalProperties: false },
		),
	],
	{
		description:
			'Entities only: when their records expire, which reads then leave out (unless withExpired): { "after": { "days": 400 } } or { "at": "until" }. Unique keys still count expired records.',
	},
);

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
		events: Type.Optional(EntityEvents),
		versioned: Type.Optional(
			Type.Boolean({
				description:
					"Entities only: adds a version identity key that update checks (optimistic concurrency, RepositoryConcurrencyConflict on a stale write) and bumps.",
			}),
		),
		expires: Type.Optional(EntityExpires),
		schemaVersion: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Entities only: the version of the stored shape (1 when absent). Rows store it under $v; reads bring older rows up through upgrade.",
			}),
		),
		upgrade: Type.Optional(
			Type.Record(Type.String({ pattern: "^[1-9][0-9]*$" }), ImportRef, {
				additionalProperties: false,
				description:
					'Entities only: the hand-written step that brings a stored row up to each version: { "2": { "import": "./upgrades.ts#toV2" } }, each (data) => data. Keys from 2 to schemaVersion.',
			}),
		),
		previousNames: Type.Optional(
			StringList(
				"Entities only: the names the entity had before; app.migrate moves their rows and start({ lock }) accepts the rename.",
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
				"findById, findBy<Key> (unique keys), findManyBy<Key> (other keys), findMany, exists, findPage, findCursor, explain (how a query would be read, without reading), forEachPage (walks the pages of a cursor query; not a step), create, update, delete, restore (soft deletion only), increment (number keys in change, atomic), count.",
		}),
		provider: Type.Optional(ProviderOrKey),
		relations: Type.Optional(
			StringList(
				"Repositories of every entity the entity holds, at any depth.",
			),
		),
		environments: Type.Optional(StringList("Environments it depends on.")),
		indexes: Type.Optional(
			Type.Record(
				Type.String({ pattern: KEY }),
				Type.Object(
					{
						where: Type.Array(Type.String(), {
							minItems: 1,
							description: "Keys the query matches by equality.",
						}),
						orderBy: Type.Optional(
							Type.String({
								description: "The scalar key it reads in order of.",
							}),
						),
					},
					{ additionalProperties: false },
				),
				{
					description:
						"Access patterns by name; a query that matches one reads through it, and the provider can build it (a GSI, an SQL index).",
				},
			),
		),
		scans: Type.Optional(
			Type.Union(
				[Type.Literal("allow"), Type.Literal("warn"), Type.Literal("reject")],
				{
					default: "allow",
					description:
						"A query only a scan serves: runs, logs repository-scan, or throws InvalidRepositoryQuery.",
				},
			),
		),
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
				restore: Type.String({
					description: "A repository dependency with soft deletion.",
				}),
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
			"A step: find, ensure, build, change, invoke, create, update, delete, restore, call, run or return (exactly one, last).",
	},
);

const RouteCookie = Type.Object(
	{
		name: Type.String({ description: "The name of the cookie." }),
		httpOnly: Type.Optional(Type.Boolean({ default: true })),
		secure: Type.Optional(Type.Boolean({ default: true })),
		sameSite: Type.Optional(
			Type.Union(
				[Type.Literal("strict"), Type.Literal("lax"), Type.Literal("none")],
				{ default: "lax" },
			),
		),
		path: Type.Optional(Type.String({ default: "/" })),
		domain: Type.Optional(Type.String()),
		maxAge: Type.Optional(
			Type.Integer({ minimum: 0, description: "Seconds the cookie lives." }),
		),
	},
	{ additionalProperties: false },
);

const UseCaseRoute = Type.Object(
	{
		method: Type.Union(
			[
				"get",
				"post",
				"put",
				"patch",
				"delete",
				"GET",
				"POST",
				"PUT",
				"PATCH",
				"DELETE",
			].map((method) => Type.Literal(method)),
			{ description: "The HTTP method, in either case." },
		),
		path: Type.Optional(
			Type.String({
				pattern: "^/",
				description:
					'After the basePath of the sink, e.g. "/posts/{slug}": a {name} segment fills the scalar input key "name". Without it, the default of the sink: /{command}/{operation}.',
			}),
		),
		status: Type.Optional(
			Type.Union(
				[
					Type.Literal(200),
					Type.Literal(201),
					Type.Literal(202),
					Type.Literal(204),
				],
				{ default: 200, description: "The status of a success." },
			),
		),
		query: Type.Optional(
			StringList(
				"Scalar input keys read from the query string. A get or delete already reads from the query every key with no other place.",
			),
		),
		headers: Type.Optional(
			Type.Record(Type.String({ pattern: KEY }), Type.String(), {
				description:
					'Scalar input keys read from request headers: { "locale": "accept-language" }.',
			}),
		),
		cookie: Type.Optional(
			Type.Record(Type.String({ pattern: KEY }), Type.String(), {
				description:
					'Scalar input keys read from cookies: { "session": "sid" }.',
			}),
		),
		setCookie: Type.Optional(
			Type.Record(Type.String({ pattern: KEY }), RouteCookie, {
				description:
					"Scalar response keys sent as cookies instead of in the body. An empty text removes the cookie.",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Where the use case is served over HTTP. The input stays the only description of what it takes: the route says where each key is read from. What is left is the JSON body of a post, put or patch, and the query of a get or delete. The route option of a sink overrides method, path and status.",
	},
);

const UseCaseAccess = Type.Union(
	[
		Type.Object(
			{ public: Type.Literal(true) },
			{ additionalProperties: false, description: "Anyone may call." },
		),
		Type.Object(
			{
				public: Type.Optional(Type.Literal(false)),
				scopes: Type.Optional(
					StringList("Scopes the caller must have, all of them."),
				),
				owner: Type.Optional(
					Type.Object(
						{
							input: Type.String({
								pattern: KEY,
								description:
									"A scalar input key that must equal the subject of the caller.",
							}),
							claim: Type.Optional(
								Type.String({
									description:
										"Compare with this claim of the caller instead of its subject.",
								}),
							),
						},
						{ additionalProperties: false },
					),
				),
				context: Type.Optional(
					Type.Record(
						Type.String({ pattern: KEY }),
						Type.String({ pattern: "^(subject|scopes|claims\\.[^.]+)$" }),
						{
							description:
								'Context keys filled from the caller, over what the request sent: "subject", "scopes" or "claims.<name>".',
						},
					),
				),
			},
			{
				additionalProperties: false,
				description:
					"An authenticated caller ({} asks for nothing more), with these scopes, that is the owner, and whose values fill the context.",
			},
		),
	],
	{
		description:
			"Who may call the use case through an output, enforced before it runs: a caller without it gets a 401 or a 403. Without access, nothing is checked.",
	},
);

const GenericUseCaseDeclaration = Type.Object(
	{
		generic: Type.String({
			description:
				"A standard use case (afora_catalog useCases): create, get, list, update, delete, restore, publish, unpublish, archive, unarchive, tag, untag, register, login, refresh or logout.",
		}),
		repository: Type.String({
			pattern: NAME,
			description:
				"The declared repository it is made for: it must have the actions, and its entity the plugins, the use case needs.",
		}),
		options: Type.Optional(
			Type.Record(Type.String({ pattern: KEY }), Type.Unknown(), {
				description:
					'Its options: "as" (the response key), "owner" ({ "key"?, "context" }), "errors" ({ "notFound" | "conflict" | "invalid" | "owner": an exception name }), and per use case "omit", "values", "set", "orderBy", and "token" for login and refresh ({ "secret": { "env": "NAME" }, "issuer"?, "audience"?, "expiresIn"?, "algorithm"?, "refresh"?: { "expiresIn" }, "scopes"?, "scopesFrom"?, "claims"? }: login then answers a token); those that write also take "before" and "after" ({ "import": "./file.ts#function" }, run before and after the write), "dependencies" (key -> name of a use case, repository or environment, for them) and "throws" (the exceptions they throw, as in "errors").',
			}),
		),
		description: Type.Optional(Type.String()),
		tags: Type.Optional(StringList("Tags, for documentation.")),
		deprecated: Type.Optional(Type.Boolean({ default: false })),
		route: Type.Optional(UseCaseRoute),
		access: Type.Optional(UseCaseAccess),
	},
	{
		additionalProperties: false,
		description:
			"A standard use case made for a repository: its input, response, dependencies and steps follow the repository and its entity.",
	},
);

const WrittenUseCaseDeclaration = Type.Object(
	{
		description: Type.Optional(Type.String()),
		tags: Type.Optional(StringList("Tags, for documentation.")),
		deprecated: Type.Optional(Type.Boolean({ default: false })),
		route: Type.Optional(UseCaseRoute),
		access: Type.Optional(UseCaseAccess),
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

const UseCaseDeclaration = Type.Union(
	[WrittenUseCaseDeclaration, GenericUseCaseDeclaration],
	{
		description:
			'A use case written here (input, response, implementation) or a standard one made for a repository ({ "generic": "create", "repository": "Posts" }).',
	},
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
				[
					Type.Literal("after-commit"),
					Type.Literal("manual"),
					EventPolicy,
					ImportRef,
				],
				{
					default: "after-commit",
					description:
						'"after-commit" (default), "manual", a policy of the catalog ({ "policy": "publishEvents", "options": { "publisher": "realtime", "topic": "posts/{id}" } }) or { "import": "./events.ts#dispatch" } (a handler written by hand).',
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
		trace: Type.Optional(
			Type.Object(
				{ import: ImportRef.properties.import },
				{
					additionalProperties: false,
					description:
						'What traces the application (applicationOf({ trace })): a tracer written by hand, { "import": "./trace.ts#tracer" }, e.g. otelTracer() of @afora/otel.',
				},
			),
		),
		publishers: Type.Optional(Publishers),
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
