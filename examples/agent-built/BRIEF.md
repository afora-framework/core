# Brief: a ticketing backend

This is the product brief every implementation in this example is built from: the afora runs (an agent working only through the `@afora/mcp` tools) and the hand-rolled Hono + Zod baseline. The HTTP contract at the end is what [the evaluation](eval/invariants.ts) calls, so it is the same for both.

This is version 2 of the brief: it adds sessions with a token and events that only their organizer can read or change. Runs made from the first version are evaluated against [version 1](BRIEF.v1.md); each run says which version it was built from in its `run.json`.

## The product

Organizers sign up, create events and sell tickets for them.

- **Organizer**: a name, an email and a password. The email identifies the organizer: two organizers cannot share one. Organizers sign up with a password and log in with their email and password; logging in gives a token the organizer sends with every request that needs to know who is calling. The password is a secret: no response ever contains it, nor anything derived from it (a hash), in any form.
- **Event**: belongs to the organizer who created it, the one signed in when it was created (it cannot be created for someone else). It has a title, a slug (lowercase letters, digits and hyphens, used in URLs; two events cannot share one) and a capacity, a whole number of seats of at least 1. Only its organizer can read it or change its title and capacity: to any other organizer it does not exist (or the request is forbidden), and without a valid token the request is refused as unauthenticated.
- **Ticket**: one seat of an event, bought by someone identified by an email (the buyer does not need an account). An event never sells more tickets than its capacity: once every seat is taken, buying is refused as "sold out".

Passwords are strong: 7 to 128 characters, with a lowercase letter, an uppercase letter, a digit and a symbol. Data is kept in memory; there is no database.

The token is a JSON Web Token signed with HMAC SHA-256 (HS256), whose subject is the id of the organizer. The signing secret is read from the environment variable `JWT_SECRET`; it is never written in the code.

## HTTP contract

JSON in and out. Every route is under `/api`.

| Route                                | Auth   | Body                        | Success                    | Business errors                                                  |
| ------------------------------------ | ------ | --------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `POST /api/organizers`               |        | `{ name, email, password }` | `201 { organizer }`        | `409` the email is taken                                         |
| `POST /api/sessions`                 |        | `{ email, password }`       | `200 { organizer, token }` | `401` unknown email or wrong password                            |
| `POST /api/events`                   | bearer | `{ title, slug, capacity }` | `201 { event }`            | `409` the slug is taken                                          |
| `GET /api/events/{id}`               | owner  |                             | `200 { event }`            | `404` no such event, or an event of another organizer (or `403`) |
| `PATCH /api/events/{id}`             | owner  | `{ title?, capacity? }`     | `200 { event }`            | `404` no such event, or an event of another organizer (or `403`) |
| `POST /api/events/{eventId}/tickets` |        | `{ buyerEmail }`            | `201 { ticket }`           | `404` no such event, `422` the event is sold out                 |

- **Auth**: `bearer` routes need the header `Authorization: Bearer <token>`, with a token from `POST /api/sessions`; `owner` routes also need the token of the event's organizer. A request without a token, or with a token that is malformed, expired or not signed with the secret, is a `401` problem. The organizer of a new event is the one of the token; the body has no organizer key.
- `organizer`, `event` and `ticket` are the stored objects, each with an `id`. An event refers to its organizer and a ticket to its event (an id or the nested object).
- **Errors** are `application/problem+json` (RFC 9457): `{ type, title, status, detail? }`, with the status above. A business error is never a `5xx`.
- **Invalid input** (a missing or malformed field, a weak password, a capacity below 1, a body that is not JSON) is a `400` problem.
- **Unknown fields** in a body are rejected with a `400` problem, never ignored: a client that sends `{ "role": "admin" }` must learn that the field does not exist.
- The password is never in a response, plain or hashed. A response may leave the key out or mask it as `"********"`.
