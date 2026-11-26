import { describe, expect, test } from "bun:test";
import { generate, type Spec, validateSpec } from "../src";

const codes = (spec: unknown) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);

/** An entity with a class written by hand, the repository that stores it and a generated entity it holds. */
type Draft = {
	version: number;
	entities: Record<string, Record<string, unknown>>;
	repositories: Record<string, Record<string, unknown>>;
	records?: Record<string, Record<string, unknown>>;
	blueprints?: Record<string, Record<string, unknown>>;
};

const base = (): Draft => ({
	version: 1,
	entities: {
		Hotel: { fields: { name: "text" } },
		Booking: {
			fields: { status: { enum: ["pending", "confirmed"] }, hotel: "Hotel" },
			change: ["status"],
			implementation: { import: "../handlers/booking#Booking" },
		},
	},
	repositories: {
		Hotels: { entity: "Hotel", actions: ["create"] },
		Bookings: {
			entity: "Booking",
			actions: ["create", "findById"],
			relations: ["Hotels"],
		},
	},
});

const entityIn = (spec: Draft, name: string) =>
	spec.entities[name] as Record<string, unknown>;

const filesOf = (spec: unknown) =>
	Object.fromEntries(
		generate(spec as Spec).map((file) => [
			file.path.slice("src/domain/".length),
			file.contents,
		]),
	);

describe("an entity with a class written by hand: validation", () => {
	test("is valid with an import", () => {
		expect(codes(base())).toEqual([]);
	});

	test("a record takes no implementation", () => {
		const spec = base();
		spec.records = {
			Note: {
				fields: { body: "text" },
				implementation: { import: "../note#Note" },
			},
		};
		expect(codes(spec)).toEqual(["unknown_key@records.Note.implementation"]);
	});

	test("an implementation is an import", () => {
		const spec = base();
		entityIn(spec, "Booking").implementation = {
			steps: [],
		};
		expect(codes(spec)).toEqual([
			"invalid_implementation@entities.Booking.implementation",
		]);
		entityIn(spec, "Booking").implementation = {
			import: "no-export",
		};
		expect(codes(spec)).toEqual([
			"invalid_import@entities.Booking.implementation",
		]);
	});

	test("the name of the generated base is free", () => {
		const spec = base();
		spec.blueprints = { BookingBase: { fields: { x: "text" } } };
		expect(codes(spec)).toEqual([
			"name_collision@entities.Booking.implementation",
		]);
	});

	test("two entities whose files have one name are a file_collision", () => {
		const spec = {
			version: 1,
			entities: {
				HTTPServer: {
					fields: { name: "text" },
					implementation: { import: "../a#A" },
				},
				HttpServer: {
					fields: { name: "text" },
					implementation: { import: "../b#B" },
				},
			},
		};
		expect(codes(spec)).toEqual(["file_collision@entities.HttpServer"]);
	});

	test("a module holding two classes that name each other is an import_cycle", () => {
		const spec = base();
		entityIn(spec, "Booking").implementation = {
			import: "../domain-code/all#Booking",
		};
		entityIn(spec, "Hotel").implementation = {
			import: "../domain-code/all#Hotel",
		};
		expect(codes(spec)).toEqual([
			"import_cycle@entities.Booking.implementation",
		]);
	});

	test("an event handler in the module of the class is an import_cycle", () => {
		const spec = base();
		entityIn(spec, "Booking").events = {
			onCreate: [
				{
					name: "created",
					handler: { import: "../handlers/booking#created" },
				},
			],
		};
		expect(codes(spec)).toEqual([
			"import_cycle@entities.Booking.implementation",
		]);
	});

	test("a record that names the class, beside one the base needs, is an import_cycle", () => {
		const spec = base();
		spec.records = {
			Address: { fields: { street: "text" } },
			Receipt: { fields: { booking: "Booking" } },
		};
		const booking = entityIn(spec, "Booking");
		booking.fields = {
			...(booking.fields as object),
			address: "Address",
		};
		expect(codes(spec)).toEqual([
			"import_cycle@entities.Booking.implementation",
		]);
	});

	test("the class cannot live in a file the generator writes", () => {
		const spec = base();
		entityIn(spec, "Booking").implementation = {
			import: "./booking.entity#Booking",
		};
		expect(codes(spec)).toContain(
			"generated_file@entities.Booking.implementation",
		);
	});
});

describe("an entity with a class written by hand: generation", () => {
	test("the base and the generated entities it needs have a file each", () => {
		const files = filesOf(base());
		expect(Object.keys(files).sort()).toEqual([
			"application.ts",
			"booking.entity.ts",
			"hotel.entity.ts",
			"index.ts",
			"repositories.ts",
		]);
		expect(files["booking.entity.ts"]).toContain(
			"export class BookingBase extends entityOf(",
		);
		expect(files["booking.entity.ts"]).toContain('name: "Booking",');
		expect(files["booking.entity.ts"]).toContain(
			'import { Hotel } from "./hotel.entity";',
		);
		expect(files["repositories.ts"]).toContain(
			'import { Booking } from "../handlers/booking";',
		);
		expect(files["repositories.ts"]).toContain("entity: Booking,");
		expect(files["application.ts"]).toContain(
			'import { Booking } from "../handlers/booking";',
		);
		expect(files["index.ts"]).toContain(
			'export { Booking } from "../handlers/booking";',
		);
		expect(files["index.ts"]).toContain('export * from "./booking.entity";');
	});

	test("events are bound to the base, and an export of another name is aliased", () => {
		const spec = base();
		const booking = entityIn(spec, "Booking");
		booking.implementation = { import: "../handlers/booking#BookingEntity" };
		booking.events = { onCreate: ["created"] };
		spec.entities = {
			...spec.entities,
			Stay: { fields: { booking: "Booking" } },
		};
		const files = filesOf(spec);
		expect(files["booking.entity.ts"]).toContain(
			'created: eventOf("created", BookingBase),',
		);
		expect(files["entities.ts"]).toContain(
			'import { BookingEntity } from "../handlers/booking";',
		);
		expect(files["entities.ts"]).toContain("booking: BookingEntity,");
		expect(files["application.ts"]).toContain("Booking: BookingEntity");
		expect(files["index.ts"]).toContain(
			'export { BookingEntity as Booking } from "../handlers/booking";',
		);
		expect(files["entities.ts"]).not.toContain("BookingBase");
	});
});
