# Brief: a ticketing backend

This is the product brief every implementation in this example is built from: the afora runs (an agent working only through the `@afora/mcp` tools) and the hand-rolled Hono + Zod baseline. The HTTP contract at the end is what [the evaluation](eval/invariants.ts) calls, so it is the same for both.

## The product

Organizers sign up, create events and sell tickets for them.

- **Organizer**: a name, an email and a password. The email identifies the organizer: two organizers cannot share one. Organizers sign up with a password and log in with their email and password. The password is a secret: no response ever contains it, nor anything derived from it (a hash), in any form.
- **Event**: belongs to an organizer. It has a title, a slug (lowercase letters, digits and hyphens, used in URLs; two events cannot share one) and a capacity, a whole number of seats of at least 1.
- **Ticket**: one seat of an event, bought by someone identified by an email (the buyer does not need an account). An event never sells more tickets than its capacity: once every seat is taken, buying is refused as "sold out".

Passwords are strong: 7 to 128 characters, with a lowercase letter, an uppercase letter, a digit and a symbol. Data is kept in memory; there is no database.

## HTTP contract

JSON in and out. Every route is under `/api`.

| Route                                | Body                                     | Success             | Business errors                                  |
| ------------------------------------ | ---------------------------------------- | ------------------- | ------------------------------------------------ |
| `POST /api/organizers`               | `{ name, email, password }`              | `201 { organizer }` | `409` the email is taken                         |
| `POST /api/sessions`                 | `{ email, password }`                    | `200 { organizer }` | `401` unknown email or wrong password            |
| `POST /api/events`                   | `{ organizerId, title, slug, capacity }` | `201 { event }`     | `404` no such organizer, `409` the slug is taken |
| `GET /api/events/{id}`               |                                          | `200 { event }`     | `404` no such event                              |
| `POST /api/events/{eventId}/tickets` | `{ buyerEmail }`                         | `201 { ticket }`    | `404` no such event, `422` the event is sold out |

- `organizer`, `event` and `ticket` are the stored objects, each with an `id`. An event refers to its organizer and a ticket to its event (an id or the nested object).
- **Errors** are `application/problem+json` (RFC 9457): `{ type, title, status, detail? }`, with the status above. A business error is never a `5xx`.
- **Invalid input** (a missing or malformed field, a weak password, a capacity below 1, a body that is not JSON) is a `400` problem.
- **Unknown fields** in a body are rejected with a `400` problem, never ignored: a client that sends `{ "role": "admin" }` must learn that the field does not exist.
- The password is never in a response, plain or hashed. A response may leave the key out or mask it as `"********"`.
