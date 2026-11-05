import { blueprintPluginOf } from "../core/blueprint/blueprint-plugin";
import { Email, Ip, Phone, Url } from "./properties/contact";
import { enumOf } from "./properties/enum";
import { SchemaProperty } from "./properties/headless";
import { Id, Slug } from "./properties/identity";
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
 * The standard properties, for blueprints to pick from, and `enumOf`, as
 * `ctx.enumOf(["draft", "published"])`.
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
	},
	{ enumOf },
);
