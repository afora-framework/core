# Overriding a repository method in a test

You test a rule of a use case without a store: the repository must say a member exists, or not, and nothing more.

```ts
import {
	blueprintOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	repositoryOf,
	useCaseOf,
} from "@afora/core";

class Member extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text, email: ctx.email })),
	{ unique: ["email"] },
) {}

export const Members = repositoryOf({
	entity: Member,
	actions: ["findByEmail", "create"],
});

export const EmailTaken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "EmailTaken",
	message: "This email already has an account.",
});

export class Join extends useCaseOf({
	name: "Join",
	blueprint: blueprintOf((ctx) => ({ name: ctx.text, email: ctx.email })),
	response: blueprintOf(() => ({ member: Member })),
	dependencies: { members: Members },
}) {
	// Every dependency is a parameter with a default: a test replaces some of them
	override async execute({ members = this.dependencies.members } = {}) {
		if (await members.findByEmail(this.input.email)) {
			throw new EmailTaken({ source: "Join" });
		}
		return { member: await members.create(this.input) };
	}
}

// What a test gives execute: only the methods the rule calls. The cast is
// there because the class types `members` as the whole repository.
export const fakeMembers = (found?: Member) =>
	({
		findByEmail: async (_email: string) => found,
		create: async (...[value]: Parameters<typeof Members.create>) =>
			value instanceof Member ? value : new Member(value),
	}) satisfies Partial<typeof Members> as typeof Members;

export { Member };
```

`execute` takes the dependencies as parameters with defaults, so a test passes a replacement for the ones it cares about; the rest resolve as usual. For a repository, give an object with the methods the rule calls. The class types `members` as the whole repository, hence `satisfies Partial<typeof Members> as typeof Members`: `satisfies` checks your fake against the real signatures, and the cast only widens it.

Overrides apply to direct dependencies, and the use case still validates the response. An instance executes once (`UseCaseAlreadyExecuted`), so build a new one for each case. A repository declared at module level is no longer usable once an application binds it (`RepositoryUsedOutsideApplication`); in a test of an application, call `app.run(Join, input)` with the in-memory provider instead.

More: [Use cases](../use-cases.md), [Testing](../testing.md), [Repositories](../repositories.md).
