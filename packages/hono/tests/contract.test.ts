import { describe, expect, it } from "bun:test";
import { httpProviderContract } from "@afora/core/testing";
import { hono } from "../src/index";

httpProviderContract(
	"hono",
	{
		sink: (options, hooks) => hono(options, hooks),
		fetch: (app, request) => app.fetch(request),
	},
	{ describe, it, expect },
);
