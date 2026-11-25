import { blueprintPluginOf } from "../core/blueprint/blueprint-plugin";
import { Email, Ip, Phone, Url } from "./properties/contact";
import { enumOf } from "./properties/enum";
import { FileProperty, fileOf } from "./properties/file";
import { SchemaProperty } from "./properties/headless";
import { Id, Slug } from "./properties/identity";
import { JsonProperty, jsonOf } from "./properties/json";
import { moneyOf } from "./properties/money";
import { Password } from "./properties/password";
import {
	BooleanProperty,
	Integer,
	NumberProperty,
	StringProperty,
	Text,
} from "./properties/primitives";
import {
	CreatedAt,
	DateProperty,
	DateTime,
	DeletedAt,
	UpdatedAt,
} from "./properties/time";

/**
 * The standard properties, for blueprints to pick from, and the factories
 * `enumOf`, `jsonOf`, `fileOf` and `money` (`moneyOf`), as
 * `ctx.enumOf(["draft", "published"])` or `ctx.money({ currency: "BRL" })`.
 */
export const Std = blueprintPluginOf(
	"std",
	{
		id: Id,
		slug: Slug,
		email: Email,
		phone: Phone,
		url: Url,
		ip: Ip,
		password: Password,
		string: StringProperty,
		text: Text,
		number: NumberProperty,
		integer: Integer,
		boolean: BooleanProperty,
		date: DateProperty,
		dateTime: DateTime,
		createdAt: CreatedAt,
		updatedAt: UpdatedAt,
		deletedAt: DeletedAt,
		schema: SchemaProperty,
		json: JsonProperty,
		file: FileProperty,
	},
	{ enumOf, jsonOf, fileOf, money: moneyOf },
);
