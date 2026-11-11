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
