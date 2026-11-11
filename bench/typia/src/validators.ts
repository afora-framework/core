// Typia makes its validators at build time, from the types below. `bun run
// typia` (ttsc, which needs Go) compiles this file to ../generated, which is
// committed, so that running the benchmark needs neither. Typia has no
// transforms, so these are the shapes of the clean values; `validateEquals`
// rejects undeclared keys, like every other contender.
import typia, { type tags } from "typia";

type Int<Min extends number> = number & tags.Type<"int32"> & tags.Minimum<Min>;
type Text<Min extends number> = string & tags.MinLength<Min>;
type Email = string & tags.Format<"email">;

type Flat = { name: Text<3>; email: Email; age: Int<0> };

type Address = { street: Text<1>; zip: Text<5> };
type Nested = Flat & {
	address: Address;
	tags: Text<1>[] & tags.MaxItems<5>;
	addresses: Address[];
};

type Order = {
	cartId: string & tags.Format<"uuid">;
	status: "pending" | "paid" | "shipped" | "cancelled";
	customer: { name: Text<2>; email: Email; phone?: Text<8> };
	shipping: {
		street: Text<1>;
		city: Text<1>;
		zip: Text<5>;
		country: string & tags.MinLength<2> & tags.MaxLength<2>;
	};
	items: Array<{
		sku: Text<3>;
		name: Text<1>;
		quantity: Int<1>;
		price: number & tags.Minimum<0>;
	}> &
		tags.MinItems<1>;
	coupon?: Text<1>;
	notes?: string & tags.MaxLength<500>;
	placedAt: string & tags.Format<"date-time">;
};

type List = {
	items: Array<{ position: Int<0>; label: Text<1>; active: boolean }>;
};

type Event =
	| { type: "click"; x: Int<0>; y: Int<0> }
	| { type: "view"; url: Text<1>; durationMs: Int<0> }
	| {
			type: "purchase";
			orderId: Text<1>;
			amount: number & tags.Minimum<0>;
			currency: string & tags.MinLength<3> & tags.MaxLength<3>;
	  }
	| { type: "signup"; email: Email; plan: "free" | "pro" };
type Events = { events: Event[] };

type Level<Child> = { name: Text<1>; count: Int<0>; child: Child };
type Deep = Level<Level<Level<Level<Level<{ name: Text<1>; count: Int<0> }>>>>>;

export const flat = typia.createValidateEquals<Flat>();
export const nested = typia.createValidateEquals<Nested>();
export const order = typia.createValidateEquals<Order>();
export const list = typia.createValidateEquals<List>();
export const events = typia.createValidateEquals<Events>();
export const deep = typia.createValidateEquals<Deep>();
