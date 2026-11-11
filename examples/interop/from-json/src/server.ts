import { App } from "./domain/index.ts";

await App.start();
export const api = App.outputs.Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
