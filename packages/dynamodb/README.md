# @afora/dynamodb

A repository provider for [`@afora/core`](../../README.md) on one [DynamoDB](https://aws.amazon.com/dynamodb/) table. It implements the provider v2 contract (queries with `where` equality and `in`, `orderBy`, `limit` / `offset`, `withDeleted`, `count`, unique keys) plus reads by cursor, expected versions, atomic increments and records that expire, and passes the `providerContract` kit of `@afora/core/testing` against DynamoDB Local. The contract and the kit are described in [docs/repositories.md](../../docs/repositories.md) and [Testing a provider](../../docs/repositories.md#testing-a-provider).

```bash
bun add @afora/core typebox @afora/dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

`@afora/core` (with the query helpers of `@afora/core/experimental`), `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` (`^3.1164.0`) are peer dependencies.

## Example

```ts
import {
	applicationOf,
	blueprintOf,
	entityOf,
	environmentOf,
	providerFrom,
	repositoryOf,
} from "@afora/core";
import { dynamoDbProvider } from "@afora/dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

class Entry extends entityOf(
	blueprintOf((ctx) => ({ slug: ctx.string, title: ctx.string })),
	{ name: "Entry", unique: ["slug"] },
) {}

const Entries = repositoryOf({
	entity: Entry,
	actions: ["create", "findBySlug", "findCursor", "update", "delete"],
});

const Env = environmentOf(blueprintOf((ctx) => ({ TABLE_NAME: ctx.string })));

export const App = applicationOf({
	name: "cms",
	environments: { Env },
	repositories: { Entries },
	provider: providerFrom(Env, (env) =>
		dynamoDbProvider({ table: env.TABLE_NAME, client: new DynamoDBClient({}) }),
	),
});
```

`dynamoDbProvider({ table, client, logger?, retry? })`:

- `table`: the name of the table (below).
- `client`: a `DynamoDBClient`, or a `DynamoDBDocumentClient` made from one. A plain client is wrapped with `removeUndefinedValues`; the provider also leaves `undefined` out itself, so a document client of your own works as it is.
- `logger`: an object with `debug` and `warn` (an application's `ILogger` fits). Retries are told as `debug` `dynamodb.retry`, errors that are not afora's own as `warn` `dynamodb.error` (`{ operation, repository, error, message }`); the error is still thrown. Nothing is logged without it.
- `retry`: `{ attempts, baseDelayMs }`, 10 and 25 ms by default: how often a request DynamoDB refuses for now is sent again, with an exponential backoff (full jitter, capped at 2 s).

## Single-table layout

One table, with two string keys, `pk` (partition) and `sk` (sort), holds every repository:

| Item   | `pk`                        | `sk`               | Attributes                             |
| ------ | --------------------------- | ------------------ | -------------------------------------- |
| Entity | `E#<repository name>`       | the id             | `data` (the stored value), `m`         |
| Marker | `U#<repository name>#<key>` | the value, encoded | `id` (of the entity holding the value) |

- **Keyed by the repository name** (`context.name`, `EntryRepository`), which comes from the `name` option of `entityOf` and so stays the same under minification and across Lambda containers: declare it. Two repositories never share items.
- **Unique keys other than `id`** are enforced with marker items, written in the same `TransactWriteItems` as the entity with `attribute_not_exists(pk)`. A failed marker condition is a `RepositoryUniqueViolation` on that key, a failed entity condition on insert one on `id`. An `update` moves the markers of the values that changed, and `remove` deletes them.
- **Encoded values**: the sort key of a marker is the JSON of the value with object keys sorted, so `1` (`1`) and `"1"` (`"1"`) are different values, and `{ a, b }` and `{ b, a }` the same one, as the contract compares them. A marker key holds up to 1024 bytes: a longer unique value throws `DynamoDbLimitExceeded`.
- **`m`**, on the entity, lists the markers it holds. `update` and `remove` condition on it, so they move the markers of the values the item still holds; when another write came first, they read again and retry.
- `update` of an unknown id and a failed existence condition are `RepositoryEntityNotFound`.

### Reads

A read gets its candidates the cheapest way: by `id` (`BatchGetItem`), through the markers of a unique key in `where`, or by querying the partition of the repository (`Query` on `pk`, every page). Then `where`, `withDeleted`, expiry, `orderBy`, `after`, `offset` and `limit` apply in memory with the same rules as `inMemoryProvider` (`selectRows` of `@afora/core/experimental`): numbers numerically, strings by code point, dates as dates, missing values first when ascending. Reads are strongly consistent. `BatchGetItem` keys left unprocessed are asked for again with backoff, up to `retry.attempts` times (then `DynamoDbRetriesExhausted`).

One read pages in DynamoDB instead: `findMany` with a `limit`, ordered by `id` ascending (or not ordered, without `after`), with no `offset` and no `where` on `id` or a unique key, which is how the backfill of `app.migrate` and a cursor by `id` read. It queries the partition from the `after` id (`sk > :after`) with `Limit`, applies `withDeleted`, expiry and `where` in memory, and queries on (`ExclusiveStartKey`) until `limit` rows match or the partition ends, so a walk reads each item once instead of the whole partition per page.

This suits repositories of thousands of items, not millions: every other read without an id or a unique key reads the whole partition. Declared `indexes` are accepted and ignored for now (`capabilities.indexes` is unset); they will become GSIs.

### Capabilities

- `keyset`: `findCursor` works (`after` is applied in memory).
- `versioning`: `update` with an expected version conditions the `Put` on `data.version`; a stale one is `RepositoryConcurrencyConflict`.
- `atomic`: `increment` is one `UpdateItem` (`SET data.views = if_not_exists(data.views, 0) + :d`), conditioned on the item existing, not soft-deleted and not expired. With `create`, a missing id is inserted (a concurrent insert of the same id gets the deltas added instead), an expired item is replaced, and a soft-deleted one is `RepositoryUniqueViolation` on `id`. An increment cannot change a unique key (`InvalidRepositoryQuery`).
- `expiry`: reads leave out records whose date is at or before `query.now`, unless `withExpired`. Expired items stay in the table and keep their unique values; the `UpdateItem` of `increment` compares the dates as strings, so keep them in UTC ISO 8601 (`toISOString()`, as the entity writes them).
- `transactions` is **not** a capability: DynamoDB writes up to 100 items at once, without reads in between, so `commandOf({ transaction: true })` cannot run on it.

## Limits

- **100 items per write**: an entity and the markers of its unique keys are written in one transaction, so an entity with more than 99 present unique values throws `DynamoDbLimitExceeded` (it is never split, since the parts would not be atomic).
- **400 KB per item**, DynamoDB's own limit, for the stored value.
- **1024 bytes per sort key**: an id or an encoded unique value.

## Schema evolution

DynamoDB has no schema to change, so `migrate` is a no-op, and a change of an entity relies on the upgrade on read and the backfill of `app.migrate` (see [Schema evolution, issue #28](https://github.com/afora-framework/core/issues/28)):

- The schema version key (`$v`, `context.schema.key`) and any other key of the stored value are kept as they are in `data`, so rows round-trip it.
- An entity renamed with `previousNames: ["Post"]` reads its old rows from the partition of the old repository name (`E#PostRepository`), since every item is keyed by `context.name`; the backfill writes them under the new name.

## The table

`PAY_PER_REQUEST`, string `pk` and `sk`, nothing else. With the AWS CDK:

```ts
import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";

const table = new TableV2(this, "Table", {
	partitionKey: { name: "pk", type: AttributeType.STRING },
	sortKey: { name: "sk", type: AttributeType.STRING },
	billing: Billing.onDemand(),
	pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
	removalPolicy: RemovalPolicy.RETAIN,
});
table.grantReadWriteData(handler); // GetItem, BatchGetItem, Query, PutItem, UpdateItem, DeleteItem, TransactWriteItems
handler.addEnvironment("TABLE_NAME", table.tableName);
```

With CloudFormation:

```yaml
Resources:
  Table:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: pk, AttributeType: S }
        - { AttributeName: sk, AttributeType: S }
      KeySchema:
        - { AttributeName: pk, KeyType: HASH }
        - { AttributeName: sk, KeyType: RANGE }
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
```

The provider needs `dynamodb:GetItem`, `BatchGetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem` and `TransactWriteItems` on the table.

## Codegen and extraction

The package exports the catalog entry for `@afora/codegen`:

```ts
export const providers = [
	{ name: "dynamodb", module: "@afora/dynamodb", export: "dynamoDbProvider" },
];
```

`client` is not JSON, so `dynamoDbProvider` is an opaque provider: give it to codegen as an import (`{ "import": "./provider.ts#provider" }`), and to `extractSpec` as an import mapping.

## Tests

`bun run test:dynamodb` runs `providerContract` against DynamoDB Local, with a fresh table per case, plus repository-level tests and unit tests of the encoding, the error mapping and the retries. Without `DYNAMODB_ENDPOINT`, the tests that need DynamoDB are skipped with a message:

```bash
docker run --rm -p 8000:8000 amazon/dynamodb-local
DYNAMODB_ENDPOINT=http://localhost:8000 bun run test:dynamodb
```

## Later

- The declared `indexes` as GSIs (`capabilities.indexes`), so reads by them stop scanning the partition.
- The expiry of records as DynamoDB TTL (a number attribute in seconds), so expired items are purged.
- Paging the partition query by `limit` for orders other than `id` (it needs a GSI on the order key).
