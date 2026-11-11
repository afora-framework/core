import { App } from "./domain";

await App.start();
const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: App.outputs.Api.build().fetch,
});
console.log(
	`Ticketing on ${server.url}api (OpenAPI at ${server.url}openapi.json)`,
);
