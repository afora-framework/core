import { App } from "./domain";

// the tokens of the brief are signed with JWT_SECRET (at least 32 characters)
if (!process.env.JWT_SECRET) throw new Error("Set JWT_SECRET to run the API.");
await App.start();
const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: App.outputs.Api.build().fetch,
});
console.log(
	`Ticketing on ${server.url}api (OpenAPI at ${server.url}openapi.json)`,
);
