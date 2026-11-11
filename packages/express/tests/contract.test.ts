import { describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpProviderContract } from "@afora/core/testing";
import type { Express } from "express";
import { express } from "../src/index";

const servers = new WeakMap<Express, Server>();

/** The app, listening on a free port. */
function listening(app: Express): Promise<Server> {
	const known = servers.get(app);
	if (known) return Promise.resolve(known);
	return new Promise((resolve) => {
		const server = app.listen(0, () => resolve(server));
		servers.set(app, server);
	});
}

httpProviderContract(
	"express",
	{
		sink: (options, hooks) => express(options, hooks),
		fetch: async (app, request) => {
			const server = await listening(app);
			const { port } = server.address() as AddressInfo;
			const url = new URL(request.url);
			return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
				method: request.method,
				headers: request.headers,
				...(request.body ? { body: await request.text() } : {}),
			});
		},
		close: (app) =>
			new Promise<void>((resolve) => {
				const server = servers.get(app);
				if (server) server.close(() => resolve());
				else resolve();
			}),
	},
	{ describe, it, expect },
);
