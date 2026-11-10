export { DynamoDbLimitExceeded, DynamoDbRetriesExhausted } from "./exceptions";
export type { DynamoDbProvider, DynamoDbProviderOptions } from "./provider";
export { dynamoDbProvider } from "./provider";

/** The provider catalog entries for `afora-codegen --providers`. */
export const providers = [
	{ name: "dynamodb", module: "@afora/dynamodb", export: "dynamoDbProvider" },
] as const;
