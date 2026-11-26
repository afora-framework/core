import { hono } from "../../../../hono/src/index.ts";

/** Who calls: a bearer token, written in code. */
const authenticate = (request: {
	header(name: string): string | undefined;
}) =>
	request.header("authorization") === "Bearer teacher"
		? { subject: "teacher-1", scopes: ["school:write"] }
		: null;

/** The sink of the API, with its hook. */
export const apiSink = hono(
	{ basePath: "/api" },
	{ authenticator: authenticate },
);
