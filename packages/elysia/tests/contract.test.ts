import { describe, expect, it } from "bun:test";
import { httpProviderContract } from "@afora/core/testing";
import { elysia } from "../src/index";

httpProviderContract(
	"elysia",
	{
		sink: (options, hooks) => elysia(options, hooks),
		fetch: (app, request) => app.handle(request),
	},
	{ describe, it, expect },
);
