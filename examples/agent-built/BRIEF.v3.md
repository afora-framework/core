# Brief: a ticketing backend (version 3)

This is the product brief every implementation in this example is built from: the afora runs (an agent working only through the `@afora/mcp` tools) and the hand-rolled Hono + Zod baseline. The HTTP contract at the end is what the evaluation calls, so it is the same for both.

## The product

Organizers sign up, create events and sell tickets for them.

- **Organizer**: a name, an email and a password. Organizers sign up, then log in with their email and password, which gives them a token they send with their requests.
- **Event**: created by an organizer, who then manages it. It has a title, a slug (lowercase letters, digits and hyphens, used in URLs) and a capacity, the number of seats. Organizers work with their own events.
- **Ticket**: one seat of an event, bought by someone identified by an email (the buyer does not need an account). Once every seat of an event is taken, it is sold out.

Passwords are 7 to 128 characters, with a lowercase letter, an uppercase letter, a digit and a symbol. Data is kept in memory; there is no database.

The token is a JSON Web Token signed with HMAC SHA-256 (HS256), whose subject is the id of the organizer. The signing secret is read from the environment variable `JWT_SECRET`.

## HTTP contract

JSON in and out. Every route is under `/api`.

| Route                                | Token | Body                        | Success                    | Errors                                           |
| ------------------------------------ | ----- | --------------------------- | -------------------------- | ------------------------------------------------ |
| `POST /api/organizers`               |       | `{ name, email, password }` | `201 { organizer }`        | `409` the email is taken                         |
| `POST /api/sessions`                 |       | `{ email, password }`       | `200 { organizer, token }` | `401` unknown email or wrong password            |
| `POST /api/events`                   | yes   | `{ title, slug, capacity }` | `201 { event }`            | `409` the slug is taken                          |
| `GET /api/events/{id}`               | yes   |                             | `200 { event }`            | `404` no such event                              |
| `PATCH /api/events/{id}`             | yes   | `{ title?, capacity? }`     | `200 { event }`            | `404` no such event                              |
| `POST /api/events/{eventId}/tickets` |       | `{ buyerEmail }`            | `201 { ticket }`           | `404` no such event, `422` the event is sold out |

- The token goes in the header `Authorization: Bearer <token>`; a request that needs one and has none, or a bad one, is a `401`.
- `organizer`, `event` and `ticket` are the stored objects, each with an `id`. An event refers to its organizer and a ticket to its event (an id or the nested object).
- Errors are `application/problem+json` (RFC 9457): `{ type, title, status, detail? }`. A body the API cannot accept (a field missing or malformed, a password too weak, a capacity below 1, a body that is not JSON) is a `400`.
