import { App } from "./domain";

const app = await App.start();
const api = app.outputs.Api.build();

Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: api.fetch });
console.log("Blog API on http://localhost:3000/api, docs at /openapi.json");
