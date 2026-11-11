import { InvalidOutputStage, toOpenAPI } from "@afora/core";
import {
	coerceTextValues,
	type OperationDescriptor,
	outputValueOf,
	type Problem,
	problemOf,
	sinkOf,
	stageCatalogOf,
	statusOf,
} from "@afora/core/adapters";
import {
	InvalidWsMessage,
	WsSubscriptionsUnavailable,
	WsTopicForbidden,
} from "./exceptions";
import type { WsHub, WsSocket } from "./hub";
import {
	parseWsMessage,
	type WsReply,
	type WsRequest,
	type WsRequestId,
} from "./protocol";

/** The options of the `websocket` sink. JSON, so the stage can live in an `afora.json`. */
export interface WebSocketOptions {
	/** Operation ids to serve (`"Posts.create"`); every operation when omitted. */
	readonly include?: readonly string[];
	/**
	 * The context of an operation, by key: `{ token: "authorization" }` fills
	 * `context.token` from the value named `authorization` of the session (or
	 * of `handle`). A missing value leaves the key out.
	 */
	readonly context?: { readonly [contextKey: string]: string };
	/**
	 * The topics a session may subscribe to: names or patterns where `*` is
	 * one segment between `/` (`"posts/*"`). Without it, every subscription
	 * is refused.
	 */
	readonly subscriptions?: { readonly topics: readonly string[] };
	/** The largest message read, in bytes. 1 MiB by default. */
	readonly maxMessageBytes?: number;
	/** Adds the `trace` to problems and the real `detail` to 5xx ones. Off by default. */
	readonly debug?: boolean;
}

/** Text values the context is read from: headers of the upgrade, a token, a user id. */
export type WsValues = Readonly<Record<string, string | undefined>>;

/** What a session is opened with. */
export interface WsSessionOptions {
	/** The values the `context` option reads, e.g. from the headers of the upgrade request. */
	readonly values?: WsValues;
	/** Where subscriptions go; without it, a subscription is a 501 problem. */
	readonly hub?: WsHub;
	/**
	 * A check after the topics of the options, such as ownership: a topic it
	 * refuses is a 403 problem. All topics the options allow by default.
	 */
	readonly authorize?: (
		topic: string,
		values: WsValues,
	) => boolean | Promise<boolean>;
}

/** One connection: what to do with each message, and when it closes. */
export interface WsSession {
	/** Reads a message and sends the reply to the socket; never throws. */
	message(data: string | ArrayBuffer | Uint8Array): Promise<void>;
	/** Leaves every topic; later messages are ignored. */
	close(): void;
	/** The topics the session is subscribed to. */
	readonly topics: readonly string[];
}

/** One operation the endpoint serves. */
export interface WsOperation {
	/** The operation id, what `op` names. */
	readonly id: string;
	readonly description?: string;
	/** JSON Schema of the input. */
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What the `websocket` sink builds. */
export interface WebSocketEndpoint {
	readonly operations: readonly WsOperation[];
	/**
	 * The reply to one message, with no connection: a call of an operation.
	 * A subscription is a 501 problem here. Never throws.
	 */
	handle(
		message: string | ArrayBuffer | Uint8Array | object,
		extra?: { readonly values?: WsValues },
	): Promise<WsReply>;
	/** A session for one socket, with subscriptions when given a hub. */
	session(socket: WsSocket, options?: WsSessionOptions): WsSession;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(options: WebSocketOptions): string | undefined {
	const given = options as unknown as Obj;
	for (const key of Object.keys(given)) {
		if (
			![
				"include",
				"context",
				"subscriptions",
				"maxMessageBytes",
				"debug",
			].includes(key)
		) {
			return `websocket has no option "${key}".`;
		}
	}
	const { include, context, subscriptions, maxMessageBytes, debug } = given;
	if (
		include !== undefined &&
		(!Array.isArray(include) ||
			include.some((id) => typeof id !== "string" || id === ""))
	) {
		return "Expected websocket.include to be a list of operation ids.";
	}
	if (context !== undefined) {
		if (!isObject(context))
			return "Expected websocket.context to be an object.";
		for (const [key, name] of Object.entries(context)) {
			if (typeof name !== "string" || name === "") {
				return `Expected websocket.context["${key}"] to be a value name.`;
			}
		}
	}
	if (subscriptions !== undefined) {
		if (
			!isObject(subscriptions) ||
			Object.keys(subscriptions).some((key) => key !== "topics") ||
			!Array.isArray(subscriptions.topics) ||
			subscriptions.topics.some(
				(topic) =>
					typeof topic !== "string" ||
					topic === "" ||
					topic.split("/").some((segment) => segment === ""),
			)
		) {
			return 'Expected websocket.subscriptions to be { "topics": ["posts/*", ...] }, with no empty segment.';
		}
	}
	if (
		maxMessageBytes !== undefined &&
		(!Number.isInteger(maxMessageBytes) || (maxMessageBytes as number) < 1)
	) {
		return "Expected websocket.maxMessageBytes to be a whole number of bytes, 1 or more.";
	}
	if (debug !== undefined && typeof debug !== "boolean") {
		return "Expected websocket.debug to be a boolean.";
	}
	return undefined;
}

/** Whether `topic` matches `pattern`, where `*` is one segment. */
function matches(pattern: string, topic: string): boolean {
	const wanted = pattern.split("/");
	const given = topic.split("/");
	return (
		wanted.length === given.length &&
		wanted.every(
			(segment, index) =>
				segment === given[index] || (segment === "*" && given[index] !== ""),
		)
	);
}

/**
 * Serves the operations over WebSocket messages, on any runtime: the sink
 * builds an endpoint, and a few lines of the runtime's WebSocket feed it
 * (see the README for Bun, Hono and Workers).
 *
 * - A request is `{ id?, op, input? }`, with `op` an operation id. The reply
 *   is `{ id, value }` (`outputValueOf`: sensitive values masked) or
 *   `{ id, problem }`, the `problemOf` of the error with the status of
 *   `statusOf` (the output `statuses` first); invalid input is a 400 with
 *   `issues`, an unknown `op` a 404, a message that is not a frame a 400
 *   `InvalidWsMessage`. `id` is the request's, or `null`.
 * - The context comes from the values of the session through the `context`
 *   option; richer rules, such as authentication, are a `transform` stage.
 * - In a session with a hub, `{ id?, subscribe: topic }` subscribes the
 *   socket (`{ id, subscribed }`) when `subscriptions.topics` and
 *   `authorize` allow it (a 403 `WsTopicForbidden` otherwise), and
 *   `{ id?, unsubscribe }` leaves the topic. The hub then sends
 *   `{ topic, event }` for each event published to the topic.
 */
export const websocket = sinkOf<WebSocketEndpoint, WebSocketOptions>({
	name: "websocket",
	validate,
	build: (operations, options, { output }) => {
		const mapping = options.context ?? {};
		const include = options.include;
		const patterns = options.subscriptions?.topics ?? [];
		const maxBytes = options.maxMessageBytes ?? 1_048_576;
		const debug = options.debug === true;
		if (include) {
			const known = new Set(operations.map((operation) => operation.id));
			const unknown = include.find((id) => !known.has(id));
			if (unknown !== undefined) {
				throw new InvalidOutputStage({
					source: "websocket",
					details: {
						reason: `websocket.include names "${unknown}", which is not an operation.`,
					},
				});
			}
		}
		const served = new Map<string, OperationDescriptor>();
		for (const operation of operations) {
			if (!include || include.includes(operation.id)) {
				served.set(operation.id, operation);
			}
		}

		const problem = (
			error: Error & { readonly name: string },
			fallback: number,
		): Problem => {
			const status = Object.hasOwn(output.statuses, error.name)
				? (output.statuses[error.name] as number)
				: fallback;
			return problemOf(error, { status, debug });
		};

		const call = async (
			request: Extract<WsRequest, { op: string }>,
			id: WsRequestId | null,
			values: WsValues,
		): Promise<WsReply> => {
			const operation = served.get(request.op);
			if (!operation) {
				return {
					id,
					problem: {
						type: "urn:afora:exception:NotFound",
						title: "NotFound",
						status: 404,
						detail: `Unknown operation "${request.op}".`,
					},
				};
			}
			const options_: { context?: unknown } = {};
			if (operation.context) {
				const raw: Record<string, string | undefined> = {};
				for (const key of Object.keys(operation.context.properties)) {
					const source = mapping[key];
					raw[key] = source === undefined ? undefined : values[source];
				}
				options_.context = coerceTextValues(operation.context, raw);
			}
			try {
				const response = await operation.invoke(request.input ?? {}, options_);
				return { id, value: outputValueOf(response) ?? null };
			} catch (error) {
				const status = statusOf(error, operation, output.statuses);
				return { id, problem: problemOf(error, { status, debug }) };
			}
		};

		const read = (
			data: string | ArrayBuffer | Uint8Array | object,
		):
			| { readonly request: WsRequest; readonly id: WsRequestId | null }
			| { readonly reply: WsReply } => {
			const parsed = parseWsMessage(data, maxBytes);
			if ("failure" in parsed) {
				const { reason, id } = parsed.failure;
				return {
					reply: {
						id,
						problem: problem(
							new InvalidWsMessage({
								source: "websocket",
								details: { reason },
							}),
							400,
						),
					},
				};
			}
			return { request: parsed.request, id: parsed.request.id ?? null };
		};

		const unavailable = (id: WsRequestId | null): WsReply => ({
			id,
			problem: problem(
				new WsSubscriptionsUnavailable({ source: "websocket" }),
				501,
			),
		});

		const handle: WebSocketEndpoint["handle"] = async (message, extra) => {
			try {
				const read_ = read(message);
				if ("reply" in read_) return read_.reply;
				const { request, id } = read_;
				if ("op" in request)
					return await call(request, id, extra?.values ?? {});
				return unavailable(id);
			} catch (error) {
				return { id: null, problem: problemOf(error, { status: 500, debug }) };
			}
		};

		const session: WebSocketEndpoint["session"] = (
			socket,
			sessionOptions = {},
		) => {
			const { hub, authorize } = sessionOptions;
			const values = sessionOptions.values ?? {};
			const topics = new Set<string>();
			let closed = false;
			const send = (reply: WsReply) => {
				try {
					socket.send(JSON.stringify(reply));
				} catch {
					// The socket is gone: nothing to answer.
				}
			};

			const subscribe = async (
				topic: string,
				id: WsRequestId | null,
			): Promise<WsReply> => {
				if (!hub) return unavailable(id);
				const allowed =
					patterns.some((pattern) => matches(pattern, topic)) &&
					(authorize ? await authorize(topic, values) : true);
				if (!allowed) {
					return {
						id,
						problem: problem(
							new WsTopicForbidden({ source: "websocket", details: { topic } }),
							403,
						),
					};
				}
				if (closed) return { id, subscribed: topic };
				hub.subscribe(topic, socket);
				topics.add(topic);
				return { id, subscribed: topic };
			};

			return {
				async message(data) {
					if (closed) return;
					try {
						const read_ = read(data);
						if ("reply" in read_) return send(read_.reply);
						const { request, id } = read_;
						if ("op" in request) return send(await call(request, id, values));
						if ("subscribe" in request) {
							return send(await subscribe(request.subscribe, id));
						}
						if (!hub) return send(unavailable(id));
						hub.unsubscribe(request.unsubscribe, socket);
						topics.delete(request.unsubscribe);
						return send({ id, unsubscribed: request.unsubscribe });
					} catch (error) {
						send({
							id: null,
							problem: problemOf(error, { status: 500, debug }),
						});
					}
				},
				close() {
					if (closed) return;
					closed = true;
					for (const topic of topics) hub?.unsubscribe(topic, socket);
					topics.clear();
				},
				get topics() {
					return [...topics];
				},
			};
		};

		return {
			operations: [...served.values()].map((operation) =>
				Object.freeze({
					id: operation.id,
					...(operation.description
						? { description: operation.description }
						: {}),
					inputSchema: toOpenAPI(operation.input) as Readonly<
						Record<string, unknown>
					>,
				}),
			),
			handle,
			session,
		};
	},
});

/** The runtime catalog of this package: the stage name `websocket` resolves to the sink. */
export const WsStages = stageCatalogOf(websocket);

/** The catalog entries codegen reads (`--stages @afora/ws`): `{ name, module, export, kind }`. */
export const stages = [
	{ name: "websocket", module: "@afora/ws", export: "websocket", kind: "sink" },
] as const;
