import { afterEach, describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	CommandEventFailed,
	commandOf,
	type EventDefinition,
	entityOf,
	eventOf,
	eventPolicyCatalogOf,
	eventPolicyDescriptionOf,
	eventPolicyOf,
	type IEventPublisher,
	InvalidEventPolicy,
	inMemoryProvider,
	memoryLogProvider,
	PublisherNotBound,
	publishEvents,
	repositoryOf,
	resetApplication,
	StdEventPolicies,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../index";
import { Password } from "../../std/properties/password";
import { memoryPublisher } from "../../testing/index";
import { ExceptionLayers } from "../exception/enums/exception-layers";

afterEach(() => resetApplication());

const handled: string[] = [];
let failOn: string | undefined;

class Member extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, password: ctx.password })),
	{ onCreate: () => Joined, change: ["name"] },
) {}
const Joined: EventDefinition = eventOf("joined", Member, async (member) => {
	if (failOn === "joined") throw new Error("joined failed");
	handled.push(`joined:${(member as Member).name}`);
});
const Renamed: EventDefinition = eventOf("renamed", Member, async () => {
	if (failOn === "renamed") throw new Error("renamed failed");
	handled.push("renamed");
});

const world = (events: unknown) => {
	const Members = repositoryOf({
		entity: Member,
		actions: ["create"],
		provider: inMemoryProvider(),
	});
	class Join extends useCaseOf({
		name: "Join",
		blueprint: blueprintOf((ctx) => ({
			name: ctx.string,
			rename: ctx.optional.boolean,
		})),
		response: blueprintOf(() => ({ member: Member })),
		dependencies: { members: Members },
	}) {
		override async execute({ members = this.dependencies.members } = {}) {
			const member = new Member({
				name: this.input.name,
				password: (await Password.hash("Str0ng!Pass")).value,
			});
			if (this.input.rename) {
				member.change.name(`${this.input.name}!`);
				(member as unknown as { emit(e: EventDefinition): void }).emit(Renamed);
			}
			return { member: await members.create(member) };
		}
	}
	const Members$ = commandOf({
		name: "Members",
		useCases: { join: Join },
		events: events as never,
	});
	return { Members, Join, Command: Members$ };
};

type Failed = InstanceType<typeof CommandEventFailed>;
const failed = (caught: unknown) => caught as Failed;
const unexpected = (): Failed => {
	throw new Error("Expected the call to fail.");
};

const reset = () => {
	handled.length = 0;
	failOn = undefined;
};

describe("eventPolicyOf", () => {
	const echo = eventPolicyOf<{ readonly label?: string }>({
		name: "echo",
		validate: (options) =>
			options.label !== undefined && typeof options.label !== "string"
				? "Expected echo.label to be a string."
				: undefined,
		handle: (events, info, options) => {
			handled.push(
				`${options.label ?? "-"}:${info.operation}:${events.length}`,
			);
		},
	});

	test("makes a handler that a command runs and an application describes", async () => {
		reset();
		const policy = echo({ label: "x" });
		expect(typeof policy).toBe("function");
		expect(eventPolicyDescriptionOf(policy)).toEqual({
			kind: "policy",
			name: "echo",
			options: { label: "x" },
		});
		expect(Object.isFrozen(eventPolicyDescriptionOf(policy)?.options)).toBe(
			true,
		);
		expect(eventPolicyDescriptionOf(() => {})).toBeUndefined();
		expect(eventPolicyDescriptionOf("after-commit")).toBeUndefined();

		const { Members, Join, Command } = world(policy);
		await Command.run("join", { name: "Ana" });
		expect(handled).toEqual(["x:join:1"]);

		const app = applicationOf({
			name: "club",
			entities: { Member },
			repositories: { Members },
			useCases: { Join },
			commands: { Members: Command },
		});
		expect(app.describe().commands.Members?.events).toEqual({
			kind: "policy",
			name: "echo",
			options: { label: "x" },
		});
	});

	test("checks its settings and options", () => {
		expect(() => eventPolicyOf({ name: "a b", handle: () => {} })).toThrow(
			"Expected the policy name to be an identifier.",
		);
		expect(() => eventPolicyOf({ name: "a" } as never)).toThrow(
			"Expected handle to be a function.",
		);
		expect(() => echo({ label: 1 } as never)).toThrow(
			"Expected echo.label to be a string.",
		);
		expect(() => echo([] as never)).toThrow("must be an object");
		expect(() => echo({ label: (() => {}) as never })).toThrow(
			InvalidEventPolicy,
		);
		const error = (() => {
			try {
				echo({ label: 1 } as never);
			} catch (caught) {
				return caught as InstanceType<typeof InvalidEventPolicy>;
			}
		})();
		expect(error?.layer).toBe(ExceptionLayers.Event);
	});

	test("catalogs resolve policies by name", () => {
		const catalog = eventPolicyCatalogOf(echo, publishEvents);
		expect(Object.keys(catalog.policies)).toEqual(["echo", "publishEvents"]);
		expect(
			eventPolicyDescriptionOf(catalog.resolve("echo", { label: "y" })),
		).toEqual({ kind: "policy", name: "echo", options: { label: "y" } });
		expect(() => catalog.resolve("nope")).toThrow(
			'Unknown event policy "nope".',
		);
		expect(() => eventPolicyCatalogOf(echo, echo)).toThrow(
			"another event policy with its name",
		);
		expect(() => eventPolicyCatalogOf((() => {}) as never)).toThrow(
			"factories made by `eventPolicyOf`",
		);
		expect(Object.keys(StdEventPolicies.policies)).toEqual(["publishEvents"]);
	});
});

describe("publishEvents", () => {
	test("validates its options", () => {
		const bad = (options: unknown, message: string) =>
			expect(() => publishEvents(options as never)).toThrow(message);
		bad({ topic: "t" }, "publishEvents.publisher");
		bad({ publisher: "a-b", topic: "t" }, "publishEvents.publisher");
		bad({ publisher: "live" }, "publishEvents.topic");
		bad({ publisher: "live", topic: "{nope}" }, "unknown placeholder {nope}");
		bad({ publisher: "live", topic: "t", events: [1] }, "publishEvents.events");
		bad(
			{ publisher: "live", topic: "t", handle: "yes" },
			"publishEvents.handle",
		);
		bad(
			{ publisher: "live", topic: "t", onPublishError: "x" },
			"onPublishError",
		);
		bad({ publisher: "live", topic: "t", other: 1 }, 'no option "other"');
		expect(() =>
			publishEvents({
				publisher: "live",
				topic: "{command}/{operation}/{event}/{id}",
			}),
		).not.toThrow();
	});

	const bound = (
		options: Parameters<typeof publishEvents>[0],
		publishers: Record<string, IEventPublisher>,
	) => {
		const { Members, Join, Command } = world(publishEvents(options));
		const app = applicationOf({
			name: "club",
			entities: { Member },
			repositories: { Members },
			useCases: { Join },
			commands: { Members: Command },
			publishers,
		});
		return { app, command: app.commands.Members };
	};

	test("runs the handlers, then publishes each event masked", async () => {
		reset();
		const live = memoryPublisher();
		const { command } = bound(
			{ publisher: "live", topic: "{command}/{event}/{id}" },
			{ live },
		);
		const { member } = await command.run("join", { name: "Ana", rename: true });

		expect(handled).toEqual(["joined:Ana!", "renamed"]);
		expect(live.published.map((entry) => entry.topic)).toEqual([
			`Members/joined/${member.id}`,
			`Members/renamed/${member.id}`,
		]);
		const [first] = live.published;
		expect(first?.event).toMatchObject({
			name: "joined",
			command: "Members",
			operation: "join",
			entity: { id: member.id, name: "Ana!", password: "********" },
		});
		expect(JSON.stringify(live.published)).not.toContain("argon2");
		expect(Object.isFrozen(first?.event)).toBe(true);
	});

	test("events limits the names; handle: false skips the handlers", async () => {
		reset();
		const live = memoryPublisher();
		const { command } = bound(
			{
				publisher: "live",
				topic: "members",
				events: ["renamed"],
				handle: false,
			},
			{ live },
		);
		await command.run("join", { name: "Ana", rename: true });
		expect(handled).toEqual([]);
		expect(live.published.map((entry) => entry.event.name)).toEqual([
			"renamed",
		]);
	});

	test("a failed handler stops with CommandEventFailed, saying which", async () => {
		reset();
		failOn = "renamed";
		const live = memoryPublisher();
		const { command } = bound({ publisher: "live", topic: "t" }, { live });
		const error = await command
			.run("join", { name: "Ana", rename: true })
			.then(unexpected, failed);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect(error.details).toEqual({
			operation: "join",
			event: "renamed",
			handled: 1,
			remaining: 0,
		});
		expect((error.cause as Error).message).toBe("renamed failed");
		expect(live.published.map((entry) => entry.event.name)).toEqual(["joined"]);
	});

	test("a failed publish is logged and skipped, or thrown", async () => {
		reset();
		const memory = memoryLogProvider();
		const failing: IEventPublisher = {
			publish() {
				throw new Error("socket closed");
			},
		};
		const { Members, Join, Command } = world(
			publishEvents({ publisher: "live", topic: "t" }),
		);
		const app = applicationOf({
			name: "club",
			entities: { Member },
			repositories: { Members },
			useCases: { Join },
			commands: { Members: Command },
			publishers: { live: failing },
			log: { providers: [memory] },
		});
		await app.commands.Members.run("join", { name: "Ana" });
		expect(handled).toEqual(["joined:Ana"]);
		const logged = memory.entries.find(
			(line) => line.event === "event-publish-failed",
		);
		expect(logged?.level).toBe("error");
		expect(logged?.fields).toMatchObject({
			command: "Members",
			operation: "join",
			event: "joined",
			publisher: "live",
			topic: "t",
		});

		const { command } = bound(
			{ publisher: "live", topic: "t", onPublishError: "throw" },
			{ live: failing },
		);
		const error = await command
			.run("join", { name: "Bia" })
			.then(unexpected, failed);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect(error.details.event).toBe("joined");
	});

	test("an application must declare the publishers its commands use", () => {
		const { Members, Join, Command } = world(
			publishEvents({ publisher: "live", topic: "t" }),
		);
		expect(() =>
			applicationOf({
				name: "club",
				entities: { Member },
				repositories: { Members },
				useCases: { Join },
				commands: { Members: Command },
			}),
		).toThrow(UnregisteredApplicationReference);
		expect(() =>
			applicationOf({
				name: "club",
				commands: {},
				publishers: { live: {} as never },
			}),
		).toThrow("publish(topic, event)");
		expect(() =>
			applicationOf({
				name: "club",
				publishers: { "not-ok": memoryPublisher() },
			}),
		).toThrow('publisher key "not-ok"');
	});

	test("publishers are inherited, rebind the commands and are described", async () => {
		reset();
		const live = memoryPublisher();
		const { Members, Join, Command } = world(
			publishEvents({ publisher: "live", topic: "t" }),
		);
		const base = applicationOf({ name: "base", publishers: { live } });
		const app = applicationOf({
			name: "club",
			extends: [base],
			entities: { Member },
			repositories: { Members },
			useCases: { Join },
			commands: { Members: Command },
		});
		expect(app.commands.Members).not.toBe(Command);
		expect(app.describe().publishers).toEqual({ live: { from: "base" } });
		expect(
			applicationOf({ name: "plain" }).describe().publishers,
		).toBeUndefined();
		await app.commands.Members.run("join", { name: "Ana" });
		expect(live.published).toHaveLength(1);
	});

	test("outside an application, the started application's publishers serve", async () => {
		reset();
		const live = memoryPublisher();
		const { Command } = world(publishEvents({ publisher: "live", topic: "t" }));

		const error = await Command.run("join", { name: "Ana" }).then(
			unexpected,
			failed,
		);
		expect(error).toBeInstanceOf(CommandEventFailed);
		expect((error.cause as Error).name).toBe("PublisherNotBound");
		expect(error.cause).toBeInstanceOf(PublisherNotBound);

		await applicationOf({ name: "club", publishers: { live } }).start();
		await Command.run("join", { name: "Bia" });
		expect(live.published.map((entry) => entry.event.name)).toEqual(["joined"]);
	});

	test("execute and the manual policy publish nothing", async () => {
		reset();
		const live = memoryPublisher();
		const { command } = bound({ publisher: "live", topic: "t" }, { live });
		const { events } = await command.execute("join", { name: "Ana" });
		expect(events).toHaveLength(1);
		expect(live.published).toEqual([]);
	});
});
