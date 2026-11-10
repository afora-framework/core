# Changelog

## Unreleased

### Added

- First version (#33). `dynamoDbProvider({ table, client, logger?, retry? })`, an `IRepositoryProvider` v2 on one DynamoDB table (`pk` / `sk`), started from the provider of afora-cms: entities at `E#<repository name>`, unique keys other than `id` enforced by marker items (`U#<repository name>#<key>`) written in the same transaction as the entity.
- Items are keyed by `context.name`, so two repositories never share items (the contract case "keeps tables of different contexts apart" passes) and the rows of a previous name stay readable under it.
- Marker values are encoded as JSON with sorted keys, so `1` and `"1"` do not collide and structured values are compared by structure.
- `update` and `remove` condition on the markers the item holds and retry when another write came first; a failed existence condition is `RepositoryEntityNotFound`, a failed marker condition `RepositoryUniqueViolation`.
- A write of more than 100 items is rejected with `DynamoDbLimitExceeded`; keys left unprocessed by `BatchGetItem` and conflicting transactions are retried with exponential backoff, up to `retry.attempts` (`DynamoDbRetriesExhausted`).
- Filtering, ordering and paging with `selectRows` of `@afora/core/experimental`, so expiry and dates order as in `inMemoryProvider`.
- `capabilities`: `keyset`, `versioning` (a conditional `Put` on `data.version`), `atomic` (one `UpdateItem`; inserts or replaces an expired item with `create`) and `expiry`. No `transactions`.
- `migrate` is a no-op: `$v` and any other key are stored in the item data as they are.
- `providers`, the `@afora/codegen` catalog entry `{ name: "dynamodb", module: "@afora/dynamodb", export: "dynamoDbProvider" }`.
- Verified by `providerContract` on DynamoDB Local (in CI as a service container), and by repository-level and unit tests.
