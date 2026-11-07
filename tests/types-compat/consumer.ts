import {
	blueprintOf,
	commandOf,
	type EventDefinition,
	type Exception,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	guard,
	type IRepositoryProvider,
	listOf,
	Meta,
	openapi,
	optionalOf,
	outputOf,
	propertyOf,
	type RecordChange,
	type RecordEffects,
	type RecordValue,
	recordOf,
	repositoryOf,
	type StandardSchemaV1,
} from "@afora/core";
import { type SliceMask, sliceOf } from "@afora/core/experimental";
import { type ContractRunner, providerContract } from "@afora/core/testing";
import { Type } from "typebox";

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	preHandle: (value) => value.trim(),
	default: "Jane",
});
const name = new Name("Alice");
export const nameIsString: Equals<typeof name.value, string> = true;

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.string,
	nickname: ctx.optional.string,
	address: Address,
	billing: optionalOf(Address),
	addresses: listOf(Address),
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

class User extends recordOf(UserBlueprint, { change: ["name", "tags"] }) {}

const MetadataFields = blueprintOf((ctx) => ({
	blueprint: ctx.string,
	options: ctx.integer,
}));
class MetadataRecord extends recordOf(MetadataFields, {
	change: ["options"],
}) {}
const metadataRecord = new MetadataRecord({ blueprint: "draft", options: 1 });
metadataRecord.change.options(2);
export const metadataBlueprint: Equals<
	(typeof metadataRecord)[typeof Meta]["blueprint"],
	typeof MetadataFields
> = true;
export const metadataValue: Equals<
	RecordValue<MetadataRecord>,
	{ blueprint: string; options: number }
> = true;
export const metadataStaticValue: Equals<
	RecordValue<typeof MetadataRecord>,
	RecordValue<MetadataRecord>
> = true;
// @ts-expect-error metadata cannot be replaced
metadataRecord[Meta] = {
	blueprint: MetadataFields,
	options: MetadataRecord.options,
};

const user = new User({
	name: "Jane",
	address: { street: "Main St", zip: "1" },
	addresses: [],
	tags: ["a"],
});

export const valueIsInferred: Equals<
	RecordValue<User>,
	{
		name: string;
		nickname?: string;
		address: { street: string; zip: string };
		billing?: { street: string; zip: string };
		addresses: { street: string; zip: string }[];
		tags: string[];
	}
> = true;

export const changed: User = user.change.name("Ann").change.tags(["b"]);
// @ts-expect-error only keys listed in `change` get a method
user.change.nickname("x");
// @ts-expect-error the value is typed
user.change.name(1);

export const effects: RecordEffects<User> = {
	name: (value, previous) => {
		const valueIsString: Equals<typeof value, string> = true;
		const previousIsString: Equals<typeof previous, string> = true;
		return [valueIsString, previousIsString];
	},
};

declare const change: RecordChange<User>;
if (change.key === "name") {
	const narrowed: Equals<typeof change.value, string> = true;
	void narrowed;
}

const UserNotCreated = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserNotCreated",
	message: "Could not create the user.",
});
export const exception: Exception = new UserNotCreated({
	source: "CreateUser",
});

const guarded = guard(
	{ layer: ExceptionLayers.UseCase, source: "CreateUser" },
	() => new Name("abc").value,
	(error, pass) => (error.is(UserNotCreated) ? "abc" : pass()),
);
export const guardedIsString: Equals<typeof guarded, string> = true;

export const nameOutput: Equals<
	StandardSchemaV1.InferOutput<typeof Name>,
	string
> = true;
export const blueprintOutput: Equals<
	StandardSchemaV1.InferOutput<typeof Address>,
	{ street: string; zip: string }
> = true;
const OptionalAddress = optionalOf(Address);
export const optionalBlueprintOutput: Equals<
	StandardSchemaV1.InferOutput<typeof OptionalAddress>,
	{ street: string; zip: string } | undefined
> = true;
export const recordOutput: User = {} as StandardSchemaV1.InferOutput<
	typeof User
>;
export const recordInput: Equals<
	StandardSchemaV1.InferInput<typeof User>,
	StandardSchemaV1.InferInput<typeof UserBlueprint>
> = true;

class Member extends entityOf(UserBlueprint, { change: ["name"] }) {}
const member = new Member({
	name: "Jane",
	address: { street: "Main St", zip: "1" },
	addresses: [],
	tags: [],
});
export const memberId: Equals<typeof member.id, string> = true;
export const memberUpdatedAt: Equals<
	typeof member.updatedAt,
	string | undefined
> = true;
export const memberChanged: Member = member.change.name("Ann").destroy();
// @ts-expect-error the identity gets no change method
member.change.id("x");

class Team extends entityOf(
	blueprintOf(() => ({ lead: Member, members: listOf(Member) })),
) {}
export const team = new Team({
	lead: member,
	members: [
		{
			name: "Ann",
			address: { street: "x", zip: "1" },
			addresses: [],
			tags: [],
		},
	],
});

class EventUser extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{
		change: ["name"],
		onCreate: () => UserCreated,
		onUpdate: () => [UserCreated],
		onDelete: () => UserCreated,
	},
) {
	greet(): string {
		return this.name;
	}
	publish(): void {
		this.emit(UserCreated);
	}
}
const UserCreated: EventDefinition = eventOf(
	"user.created",
	EventUser,
	async (entity) => {
		const _inferred: Equals<typeof entity, EventUser> = true;
		entity.greet();
	},
);
const eventUser = new EventUser({ name: "Jane" });
export const changedEventUser: EventUser = eventUser.change.name("Ann");
// @ts-expect-error emit is protected
eventUser.emit(UserCreated);
// @ts-expect-error records cannot define entity events
eventOf("record", User, async () => {});
// @ts-expect-error synchronous handlers are not allowed
eventOf("sync", EventUser, () => {});
// @ts-expect-error handlers must resolve to void
eventOf("result", EventUser, async () => 1);
// @ts-expect-error change inference is preserved
eventUser.change.name(1);
// @ts-expect-error records have no event queue
user.pullEvents();

// UseCase declarations retain inference and abstract contracts across compiler versions.
import {
	type UseCaseDependencies,
	type UseCaseInput,
	type UseCaseResponse,
	useCaseOf,
} from "@afora/core";

const OperationInput = blueprintOf((ctx) => ({ name: ctx.string }));
class OperationUser extends entityOf(OperationInput) {}
const OperationOutput = blueprintOf(() => ({ user: OperationUser }));
const CreateOperationBase = useCaseOf({
	name: "CreateOperation",
	blueprint: OperationInput,
	response: OperationOutput,
});
class CreateOperation extends CreateOperationBase {
	override async execute() {
		return { user: new OperationUser(this.input) };
	}
}
const ParentOperationBase = useCaseOf({
	name: "ParentOperation",
	blueprint: OperationInput,
	response: OperationOutput,
	dependencies: { create: CreateOperation },
});
class ParentOperation extends ParentOperationBase {
	override async execute({ create = this.dependencies.create } = {}) {
		return create(this.input);
	}
}
export const operationInputMatches: Equals<
	UseCaseInput<typeof CreateOperation>,
	{ name: string }
> = true;
export const operationResponseMatches: Equals<
	UseCaseResponse<typeof CreateOperation>,
	{ user: OperationUser }
> = true;
export const dependencyMatches: Equals<
	UseCaseDependencies<typeof ParentOperation>["create"],
	(input: { name: string }) => Promise<{ user: OperationUser }>
> = true;
const operation = new ParentOperation({ name: "Ana" });
operation.execute();
new ParentOperation({ name: "Ana" }).execute({
	create: async () => ({ user: new OperationUser({ name: "Stub" }) }),
});
operation.pullEvents();
// @ts-expect-error concrete subclasses must implement execute
class _MissingOperation extends CreateOperationBase {}
// @ts-expect-error abstract declarations cannot be instantiated
new CreateOperationBase({ name: "Ana" });
// @ts-expect-error constructor input is validated by types
new CreateOperation({ name: 42 });
useCaseOf({
	name: "Invalid",
	blueprint: OperationInput,
	response: OperationOutput,
	// @ts-expect-error only concrete UseCases are dependencies
	dependencies: { user: OperationUser },
});
// @ts-expect-error unknown override
operation.execute({ unknown: async () => ({}) });

// Record plugins
import {
	hasPlugin,
	repositoryOf as pluginRepositoryOf,
	recordPluginCatalogOf,
	recordPluginOf,
	StdRecordPlugins,
} from "@afora/core";

class SluggedRecord extends recordOf(
	blueprintOf((ctx) => ({ slug: ctx.slug, code: ctx.string })),
	{ unique: ["code"], change: ["code"] },
) {
	get path(): string {
		return `/${this.slug}`;
	}
}
const Slugged = recordPluginOf("slugged", SluggedRecord);

class PluggedPost extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{ plugins: (ctx) => [ctx.publishable, Slugged] },
) {}
const plugged = new PluggedPost({ title: "Hi", slug: "hi", code: "a" });
export const pluginKey: Equals<typeof plugged.slug, string> = true;
export const pluginGetter: Equals<typeof plugged.path, string> = true;
export const pluginMethod: Equals<
	ReturnType<typeof plugged.publish>,
	PluggedPost
> = true;
plugged.change.code("b");
// @ts-expect-error the keys of a plugin are required like any other
new PluggedPost({ title: "Hi" });
entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		// @ts-expect-error the context has only the catalog's plugins
		plugins: (ctx) => [ctx.nope],
	},
);

const PluggedPosts = pluginRepositoryOf({
	entity: PluggedPost,
	actions: ["findBySlug", "findByCode"],
});
PluggedPosts.findByCode("a");
pluginRepositoryOf({
	entity: PluggedPost,
	// @ts-expect-error title is not unique
	actions: ["findByTitle"],
});

const anything: unknown = plugged;
if (hasPlugin(anything, Slugged)) {
	const path: string = anything.path;
	path.toUpperCase();
}
recordPluginCatalogOf(Slugged, ...StdRecordPlugins.list).resolve("slugged");

// Applications: names are inferred, also through `extends` and `extend`.
import {
	blueprintOf as appBlueprintOf,
	entityOf as appEntityOf,
	applicationOf as appOf,
	repositoryOf as appRepositoryOf,
} from "@afora/core";

const AppUser = appEntityOf(appBlueprintOf((ctx) => ({ name: ctx.string })));
const AppUsers = appRepositoryOf({
	entity: AppUser,
	actions: ["findById", "create"],
});
const AuthApp = appOf({
	name: "auth",
	entities: { AppUser },
	repositories: { AppUsers },
});
const ChildApp = appOf({ name: "child", extends: [AuthApp] });
const sameUsers: typeof AppUsers = ChildApp.repositories.AppUsers;
const extendedUsers: typeof AppUsers = appOf({ name: "x" }).extend(AuthApp)
	.repositories.AppUsers;
void sameUsers;
void extendedUsers;
// @ts-expect-error an unregistered name
ChildApp.repositories.Nope;

// the experimental subpath
const SlicedAddress = sliceOf(Address, { zip: true });
export const slicedKeys: Equals<keyof typeof SlicedAddress.properties, "zip"> =
	true;
export type AddressMask = SliceMask<typeof Address.properties>;

// The provider contract kit is runner-agnostic.
declare const runner: ContractRunner;
declare const makeProvider: () => IRepositoryProvider;
providerContract(runner, makeProvider, { transactions: false });

// Queries, steps, commands and outputs (1.0).
class ClubMember extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		age: ctx.integer,
		email: ctx.email,
	})),
	{ unique: ["email"] },
) {}
const ClubMembers = repositoryOf({
	entity: ClubMember,
	actions: ["findByEmail", "findMany", "findPage", "create"],
	deletion: "soft",
});
export const adults: Promise<ClubMember[]> = ClubMembers.findMany({
	where: { age: { in: [18, 21] } },
	orderBy: [{ key: "name", direction: "desc" }],
	limit: 10,
});
// @ts-expect-error an unknown query key
ClubMembers.findMany({ where: { nope: 1 } });

const ClubMemberExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "ClubMemberExists",
	message: "The member exists.",
});
class Join extends useCaseOf({
	name: "Join",
	blueprint: blueprintOf((ctx) => ({
		name: ctx.string,
		age: ctx.integer,
		email: ctx.email,
	})),
	response: blueprintOf(() => ({ member: ClubMember })),
	context: blueprintOf((ctx) => ({ actor: ctx.optional.string })),
	dependencies: { members: ClubMembers },
	errors: [ClubMemberExists],
	steps: [
		{ find: "members.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: ClubMemberExists },
		{ create: "members", value: "$input", as: "member" },
		{ return: { member: "$member" } },
	],
}) {}
const BadInput = blueprintOf((ctx) => ({ email: ctx.email }));
const BadResponse = blueprintOf(() => ({}));
const badDependencies = { members: ClubMembers };
// biome-ignore format: TypeScript 5 and 7 report the overload on different lines of a multi-line call
// @ts-expect-error a find of an action the repository lacks
useCaseOf({ name: "Bad", blueprint: BadInput, response: BadResponse, dependencies: badDependencies, steps: [{ find: "members.findById", args: ["$input.email"] }, { return: {} }] });

const Club = commandOf({
	name: "Club",
	useCases: { join: Join },
	transaction: true,
});
export const joined: Promise<{ readonly member: ClubMember }> = Club.run(
	"join",
	{ name: "Ana", age: 30, email: "ana@example.com" },
	{ context: {} },
);
// @ts-expect-error an unknown operation
Club.run("leave", {});

const ClubApi = outputOf({
	name: "ClubApi",
	commands: [Club],
	pipe: [openapi({ info: { title: "Club", version: "1.0.0" } })],
});
export const clubDocument = ClubApi.build();

// The started application, typed by augmenting `Register` once per project.
import { useApplication as useAppOf } from "@afora/core";

declare module "@afora/core" {
	interface Register {
		application: typeof AuthApp;
	}
}
const registered: Equals<ReturnType<typeof useAppOf>, typeof AuthApp> = true;
void registered;
const fromAnywhere: typeof AppUsers = useAppOf().get(AppUsers);
void fromAnywhere;
