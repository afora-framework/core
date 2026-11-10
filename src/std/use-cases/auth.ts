import {
	UseCaseEntityConflict,
	UseCaseInvalidCredentials,
} from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import { StringProperty } from "../properties/primitives";
import { createCompilation } from "./crud";
import { asOf, checkOptions, errorOf, fields, metaOf } from "./shared";
import type { LoginMaker, RegisterMaker } from "./types";

const authenticatable = (actions: readonly string[]) => ({
	requires: { actions, plugins: ["authenticatable"] },
});

/** Stores an authenticatable entity, unless its email is taken. */
export const register = useCasePluginOf<"register", RegisterMaker>("register", {
	description:
		"Stores an authenticatable entity built from the input, its password given plain and stored as a hash, unless the email is taken.",
	...authenticatable(["findByEmail", "create"]),
	compile: (target, options) => {
		const conflict = errorOf(
			target,
			options,
			"conflict",
			UseCaseEntityConflict,
		);
		return createCompilation(
			target,
			options,
			"Register",
			(input) => [
				{
					find: "repository.findByEmail",
					args: [`${input}.email`],
					as: "existing",
				},
				{ ensure: "absent", value: "$existing", error: conflict },
			],
			[conflict],
		);
	},
});

/** Gives the authenticatable entity of an email, when the password matches. */
export const login = useCasePluginOf<"login", LoginMaker>("login", {
	description:
		"Gives the authenticatable entity of an email when the password matches; issues no token.",
	...authenticatable(["findByEmail"]),
	compile: (target, options) => {
		checkOptions(target, options, ["as"]);
		const invalid = errorOf(
			target,
			options,
			"invalid",
			UseCaseInvalidCredentials,
		);
		return {
			...metaOf(target, options, "Login"),
			blueprint: fields(() => ({
				email: target.field("email").field,
				password: StringProperty,
			})),
			response: fields(() => ({ [asOf(target, options)]: target.entity })),
			dependencies: { repository: target.repository },
			errors: [invalid],
			steps: [
				{ find: "repository.findByEmail", args: ["$input.email"], as: "item" },
				{ ensure: "exists", value: "$item", error: invalid },
				{
					invoke: "$item",
					method: "verifyPassword",
					args: ["$input.password"],
					as: "matches",
				},
				{ ensure: "true", value: "$matches", error: invalid },
				{ return: { [asOf(target, options)]: "$item" } },
			],
		};
	},
});
