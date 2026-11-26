import { afterAll, describe, expect, test } from "bun:test";
import { ExtractionError, extractSpec, validateSpec } from "../../src";
import {
	BOOKING_CLASS,
	BOOKINGS_IMPORTS,
	bookingsSpec,
} from "./fixtures/bookings";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

/** Books a stay through the generated use case, then confirms it through the method written by hand. */
async function behave(App: Any) {
	const { Hotels, Bookings, Stays } = App.repositories;
	const hotel = await Hotels.create({ name: "Sea View" });
	const { booking } = await new App.useCases.Book({
		guest: "Ana",
		hotel: hotel.id,
	}).execute();
	const found = await Bookings.findById(booking.id);
	found.pullEvents();
	found.confirm();
	const raised = found.pullEvents().map((event: Any) => event.name);
	await Bookings.update(found);
	const stay = await Stays.create({ booking: found, nights: 3 });
	const reloaded = await Stays.findById(stay.id);
	return {
		built: typeof booking.confirm,
		found: typeof found.confirm,
		raised,
		status: (await Bookings.findById(booking.id)).status,
		hotel: (await Bookings.findById(booking.id)).hotel.name,
		nested: typeof reloaded.booking.confirm,
		described: App.describe().entities.Booking.implementation,
		generated: App.describe().entities.Hotel.implementation,
	};
}

describe("JSON -> app -> JSON: an entity with a class written by hand", () => {
	test("the spec is valid", () => {
		expect(validateSpec(bookingsSpec)).toEqual([]);
	});

	test("generates clean code, behaves and extracts to the same spec", async () => {
		const project = await buildProject(
			[{ root: ".", spec: bookingsSpec }],
			{},
			{ "src/handlers/booking.ts": BOOKING_CLASS },
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await behave(App)).toEqual({
			built: "function",
			found: "function",
			raised: ["confirmed"],
			status: "confirmed",
			hotel: "Sea View",
			nested: "function",
			described: "class",
			generated: undefined,
		});

		expect(() => extractSpec(App, { outputDir: "src/bookings" })).toThrow(
			ExtractionError,
		);
		const extracted = extractSpec(App, {
			outputDir: "src/bookings",
			imports: BOOKINGS_IMPORTS,
		});
		expect(validateSpec(extracted)).toEqual([]);
		expect(canonical(extracted)).toEqual(canonical(bookingsSpec));
	}, 180_000);
});
