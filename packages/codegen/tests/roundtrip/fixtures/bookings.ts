import type { Spec } from "../../../src";

/** What extraction needs: the class written by hand of `Booking`. */
export const BOOKINGS_IMPORTS = {
	"entities.Booking": "../handlers/booking#Booking",
};

/** The class written by hand: a state transition that raises an event of its own. */
export const BOOKING_CLASS = `import { eventOf } from "@afora/core";
import { BookingBase } from "../bookings/booking.entity";

export const confirmed = eventOf("confirmed", BookingBase);

export class Booking extends BookingBase {
	confirm(): void {
		this.change.status("confirmed");
		this.emit(confirmed);
	}
}
`;

/**
 * An entity with a class written by hand (`Booking`), a generated entity it
 * holds (`Hotel`, given a file of its own) and a generated entity that holds
 * it (`Stay`): repositories, relations, a `build` step and the application
 * use the class written by hand.
 */
export const bookingsSpec: Spec = {
	version: 1,
	name: "bookings",
	output: { dir: "src/bookings" },
	entities: {
		Hotel: { fields: { name: "text" } },
		Booking: {
			fields: {
				guest: "text",
				status: { enum: ["pending", "confirmed"] },
				hotel: "Hotel",
			},
			change: ["status"],
			events: { onCreate: ["created"] },
			implementation: { import: "../handlers/booking#Booking" },
		},
		Stay: { fields: { booking: "Booking", nights: "integer" } },
	},
	repositories: {
		Hotels: { entity: "Hotel", actions: ["create", "findById"] },
		Bookings: {
			entity: "Booking",
			actions: ["create", "findById", "update"],
			relations: ["Hotels"],
		},
		Stays: {
			entity: "Stay",
			actions: ["create", "findById"],
			relations: ["Bookings"],
		},
	},
	exceptions: {
		UnknownHotel: { layer: "use-case", message: "No such hotel." },
	},
	useCases: {
		Book: {
			input: { fields: { guest: "text", hotel: "id" } },
			response: { fields: { booking: "Booking" } },
			dependencies: { hotels: "Hotels", bookings: "Bookings" },
			errors: ["UnknownHotel"],
			implementation: {
				steps: [
					{ find: "hotels.findById", args: ["$input.hotel"], as: "hotel" },
					{ ensure: "exists", value: "$hotel", error: "UnknownHotel" },
					{
						build: "Booking",
						values: {
							guest: "$input.guest",
							status: "pending",
							hotel: "$hotel",
						},
						as: "booking",
					},
					{ create: "bookings", value: "$booking", as: "saved" },
					{ return: { booking: "$saved" } },
				],
			},
		},
	},
};
