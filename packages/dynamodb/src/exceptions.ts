import { ExceptionLayers, exceptionOf } from "@afora/core";

/**
 * A write or a value goes past a limit of DynamoDB: a transaction of more
 * than 100 items, or a unique value whose marker key passes 1024 bytes.
 * `source` is the repository name.
 */
export const DynamoDbLimitExceeded = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "DynamoDbLimitExceeded",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/**
 * DynamoDB kept refusing a request after every attempt: keys left
 * unprocessed by `BatchGetItem` (throttling), or a transaction cancelled by
 * conflicting ones. `source` is the repository name.
 */
export const DynamoDbRetriesExhausted = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "DynamoDbRetriesExhausted",
	message: ({
		operation,
		attempts,
	}: {
		readonly operation: string;
		readonly attempts: number;
	}) => `DynamoDB ${operation} did not complete after ${attempts} attempts.`,
});
