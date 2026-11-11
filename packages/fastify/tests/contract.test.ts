import { describe, expect, it } from "bun:test";
import { httpProviderContract } from "@afora/core/testing";
import { fastify } from "../src/index";

httpProviderContract(
	"fastify",
	{
		sink: (options, hooks) => fastify(options, hooks),
		fetch: async (app, request) => {
			const url = new URL(request.url);
			const response = await app.inject({
				method: request.method as "GET",
				url: `${url.pathname}${url.search}`,
				headers: Object.fromEntries(request.headers),
				...(request.body ? { payload: await request.text() } : {}),
			});
			const headers = new Headers();
			for (const [name, value] of Object.entries(response.headers)) {
				for (const item of [value].flat()) {
					if (item !== undefined) headers.append(name, String(item));
				}
			}
			return new Response(response.statusCode === 204 ? null : response.body, {
				status: response.statusCode,
				headers,
			});
		},
		close: (app) => app.close(),
	},
	{ describe, it, expect },
);
