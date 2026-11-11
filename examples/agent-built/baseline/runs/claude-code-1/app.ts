import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Problem details (RFC 9457)
// ---------------------------------------------------------------------------

class Problem extends Error {
	constructor(
		readonly status: number,
		readonly title: string,
		readonly detail?: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(detail ?? title);
	}
}

function problemResponse(problem: Problem): Response {
	return new Response(
		JSON.stringify({
			type: `about:blank#${problem.title.toLowerCase().replace(/\s+/g, "-")}`,
			title: problem.title,
			status: problem.status,
			...(problem.detail ? { detail: problem.detail } : {}),
			...problem.extra,
		}),
		{
			status: problem.status,
			headers: { "content-type": "application/problem+json" },
		},
	);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const password = z
	.string()
	.min(7)
	.max(128)
	.regex(/[a-z]/, "must contain a lowercase letter")
	.regex(/[A-Z]/, "must contain an uppercase letter")
	.regex(/\d/, "must contain a digit")
	.regex(/[^A-Za-z0-9]/, "must contain a symbol");

const RegisterBody = z
	.object({
		name: z.string().trim().min(1),
		email: z.email(),
		password,
	})
	.strict();

const LoginBody = z
	.object({
		email: z.email(),
		password: z.string().min(1),
	})
	.strict();

const CreateEventBody = z
	.object({
		organizerId: z.string().min(1),
		title: z.string().trim().min(1),
		slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		capacity: z.number().int().min(1),
	})
	.strict();

const BuyTicketBody = z
	.object({
		buyerEmail: z.email(),
	})
	.strict();

async function parseBody<T extends z.ZodType>(
	request: Request,
	schema: T,
): Promise<z.infer<T>> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		throw new Problem(400, "Bad Request", "The body is not valid JSON.");
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		throw new Problem(400, "Bad Request", "The body is invalid.", {
			issues: result.error.issues.map((issue) => ({
				path: issue.path,
				code: issue.code,
				message: issue.message,
			})),
		});
	}
	return result.data;
}

// ---------------------------------------------------------------------------
// Storage (in memory)
// ---------------------------------------------------------------------------

interface Organizer {
	id: string;
	name: string;
	email: string;
	passwordHash: string;
	createdAt: string;
}

interface Event {
	id: string;
	organizerId: string;
	title: string;
	slug: string;
	capacity: number;
	createdAt: string;
}

interface Ticket {
	id: string;
	eventId: string;
	buyerEmail: string;
	createdAt: string;
}

const organizers = new Map<string, Organizer>();
const organizersByEmail = new Map<string, string>();
const events = new Map<string, Event>();
const eventsBySlug = new Map<string, string>();
const tickets = new Map<string, Ticket>();
const ticketCount = new Map<string, number>();

const publicOrganizer = ({ passwordHash: _, ...organizer }: Organizer) =>
	organizer;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const app = new Hono().basePath("/api");

app.post("/organizers", async (c) => {
	const body = await parseBody(c.req.raw, RegisterBody);
	const email = body.email.toLowerCase();
	if (organizersByEmail.has(email)) {
		throw new Problem(
			409,
			"Conflict",
			"An organizer with this email already exists.",
		);
	}
	const organizer: Organizer = {
		id: crypto.randomUUID(),
		name: body.name,
		email,
		passwordHash: await Bun.password.hash(body.password),
		createdAt: new Date().toISOString(),
	};
	organizers.set(organizer.id, organizer);
	organizersByEmail.set(email, organizer.id);
	return c.json({ organizer: publicOrganizer(organizer) }, 201);
});

app.post("/sessions", async (c) => {
	const body = await parseBody(c.req.raw, LoginBody);
	const id = organizersByEmail.get(body.email.toLowerCase());
	const organizer = id ? organizers.get(id) : undefined;
	if (
		!organizer ||
		!(await Bun.password.verify(body.password, organizer.passwordHash))
	) {
		throw new Problem(401, "Unauthorized", "Wrong email or password.");
	}
	return c.json({ organizer: publicOrganizer(organizer) });
});

app.post("/events", async (c) => {
	const body = await parseBody(c.req.raw, CreateEventBody);
	if (!organizers.has(body.organizerId)) {
		throw new Problem(404, "Not Found", "No such organizer.");
	}
	if (eventsBySlug.has(body.slug)) {
		throw new Problem(
			409,
			"Conflict",
			"An event with this slug already exists.",
		);
	}
	const event: Event = {
		id: crypto.randomUUID(),
		organizerId: body.organizerId,
		title: body.title,
		slug: body.slug,
		capacity: body.capacity,
		createdAt: new Date().toISOString(),
	};
	events.set(event.id, event);
	eventsBySlug.set(event.slug, event.id);
	return c.json({ event }, 201);
});

app.get("/events/:id", (c) => {
	const event = events.get(c.req.param("id"));
	if (!event) throw new Problem(404, "Not Found", "No such event.");
	return c.json({ event });
});

app.post("/events/:eventId/tickets", async (c) => {
	const event = events.get(c.req.param("eventId"));
	if (!event) throw new Problem(404, "Not Found", "No such event.");
	const body = await parseBody(c.req.raw, BuyTicketBody);
	const sold = ticketCount.get(event.id) ?? 0;
	if (sold >= event.capacity) {
		throw new Problem(422, "Sold Out", "Every seat of this event is taken.");
	}
	const ticket: Ticket = {
		id: crypto.randomUUID(),
		eventId: event.id,
		buyerEmail: body.buyerEmail,
		createdAt: new Date().toISOString(),
	};
	tickets.set(ticket.id, ticket);
	ticketCount.set(event.id, sold + 1);
	return c.json({ ticket }, 201);
});

app.notFound(() =>
	problemResponse(new Problem(404, "Not Found", "No such route.")),
);

app.onError((error) => {
	if (error instanceof Problem) return problemResponse(error);
	if (error instanceof HTTPException) {
		return problemResponse(new Problem(error.status, "Error", error.message));
	}
	console.error(error);
	return problemResponse(new Problem(500, "Internal Server Error"));
});

export default app;
