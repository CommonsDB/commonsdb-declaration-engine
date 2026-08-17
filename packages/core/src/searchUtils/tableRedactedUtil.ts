// src/consumer.ts
// import fs
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Table } from "sst/node/table";

const dynamoDBClient = new DynamoDBClient({});

export async function writeRedactedMappingToDB(identifier: string, isRedacted: boolean) {
  try {
    console.log(">>>Writing redacted mapping to DynamoDB..", identifier, "-->", isRedacted);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.Redacted.tableName,
        Item: {
          identifier: { S: identifier },
          redacted: { N: isRedacted ? "1" : "0" },
        },
      }),
    );
    console.log(">>>SUCCESS: DynamoDB..", identifier, "-->", isRedacted);
  } catch (error) {
    console.error(">>>ERROR: Failed to write redacted mapping to DynamoDB..", identifier, "-->", isRedacted, error);
  }
}

export async function writeRedactedMappingsToDB(
  identifiers: string[],
  isRedacted: boolean,
): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = [];
  const failed: string[] = [];

  if (identifiers.length === 0) return { success, failed };

  // Deduplicate identifiers - DynamoDB BatchWriteItem doesn't allow duplicate keys
  const uniqueIdentifiers = [...new Set(identifiers)];

  console.log(
    ">>>Writing batch redacted mappings to DynamoDB..",
    uniqueIdentifiers.length,
    "unique items (from",
    identifiers.length,
    "total) -->",
    isRedacted,
  );

  // DynamoDB BatchWriteItem supports max 25 items per request
  const BATCH_SIZE = 25;
  const batches: string[][] = [];

  for (let i = 0; i < uniqueIdentifiers.length; i += BATCH_SIZE) {
    batches.push(uniqueIdentifiers.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const putRequests = batch.map((identifier) => ({
        PutRequest: {
          Item: {
            identifier: { S: identifier },
            redacted: { N: isRedacted ? "1" : "0" },
          },
        },
      }));

      const result = await dynamoDBClient.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [Table.Redacted.tableName]: putRequests,
          },
        }),
      );

      // Handle unprocessed items
      const unprocessed = result.UnprocessedItems?.[Table.Redacted.tableName];
      if (unprocessed && unprocessed.length > 0) {
        const unprocessedIds = unprocessed
          .map((item) => item.PutRequest?.Item?.identifier?.S)
          .filter((id): id is string => !!id);
        failed.push(...unprocessedIds);
        const processedIds = batch.filter((id) => !unprocessedIds.includes(id));
        success.push(...processedIds);
      } else {
        success.push(...batch);
      }
    } catch (error) {
      console.error(">>>ERROR: Failed to write batch redacted mappings to DynamoDB..", batch, (error as Error).message);
      failed.push(...batch);
    }
  }

  console.log(">>>BATCH COMPLETE: DynamoDB..", success.length, "success,", failed.length, "failed");
  return { success, failed };
}

export async function writeRedactedProductMappingToDB(productId: string, isRedacted: boolean) {
  try {
    console.log(">>>Writing redacted products mapping to DynamoDB..", productId, "-->", isRedacted);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.RedactedProducts.tableName,
        Item: {
          productId: { S: productId },
          redacted: { N: isRedacted ? "1" : "0" },
        },
      }),
    );
    console.log(">>>SUCCESS: DynamoDB..", productId, "-->", isRedacted);
  } catch (error) {
    console.error(">>>ERROR: Failed to write redacted mapping to DynamoDB..", productId, "-->", isRedacted, error);
  }
}

export async function writeRedactedProductMappingsToDB(
  productIds: string[],
  isRedacted: boolean,
): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = [];
  const failed: string[] = [];

  if (productIds.length === 0) return { success, failed };

  // Deduplicate productIds - DynamoDB BatchWriteItem doesn't allow duplicate keys
  const uniqueProductIds = [...new Set(productIds)];

  console.log(
    ">>>Writing batch redacted product mappings to DynamoDB..",
    uniqueProductIds.length,
    "unique items (from",
    productIds.length,
    "total) -->",
    isRedacted,
  );

  // DynamoDB BatchWriteItem supports max 25 items per request
  const BATCH_SIZE = 25;
  const batches: string[][] = [];

  for (let i = 0; i < uniqueProductIds.length; i += BATCH_SIZE) {
    batches.push(uniqueProductIds.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const putRequests = batch.map((productId) => ({
        PutRequest: {
          Item: {
            productId: { S: productId },
            redacted: { N: isRedacted ? "1" : "0" },
          },
        },
      }));

      const result = await dynamoDBClient.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [Table.RedactedProducts.tableName]: putRequests,
          },
        }),
      );

      // Handle unprocessed items
      const unprocessed = result.UnprocessedItems?.[Table.RedactedProducts.tableName];
      if (unprocessed && unprocessed.length > 0) {
        const unprocessedIds = unprocessed
          .map((item) => item.PutRequest?.Item?.productId?.S)
          .filter((id): id is string => !!id);
        failed.push(...unprocessedIds);
        const processedIds = batch.filter((id) => !unprocessedIds.includes(id));
        success.push(...processedIds);
      } else {
        success.push(...batch);
      }
    } catch (error) {
      console.error(">>>ERROR: Failed to write batch redacted product mappings to DynamoDB..", batch, error);
      failed.push(...batch);
    }
  }

  console.log(">>>BATCH COMPLETE: DynamoDB products..", success.length, "success,", failed.length, "failed");
  return { success, failed };
}

export async function getIsRedactedByIdentifier(identifier: string): Promise<boolean> {
  try {
    console.log("Getting redacted mapping from DB for identifier:", identifier);
    const result = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: Table.Redacted.tableName,
        Key: { identifier: { S: identifier } },
      }),
    );

    if (result.Item) {
      const redacted = result.Item.redacted.N;
      return redacted === "1";
    } else {
      console.log("No redacted mapping found for identifier:", identifier);
      return false;
    }
  } catch (error) {
    console.error("Error getting redacted mapping from DB for identifier:", identifier, error);
    throw error;
  }
}

/** @deprecated Use getIsRedactedByIdentifier instead */
export const getIsRedactedByDeclarationId = getIsRedactedByIdentifier;

/** @deprecated Use getIsRedactedByIdentifiers instead - this function uses wrong key name */
export async function getIsRedactedByDeclarationIds(declarationIds: string[]): Promise<{ [key: string]: boolean }> {
  console.warn("DEPRECATED: getIsRedactedByDeclarationIds is deprecated, use getIsRedactedByIdentifiers instead");
  return getIsRedactedByIdentifiers(declarationIds);
}

const BATCH_GET_MAX_KEYS = 100; // DynamoDB BatchGetItem limit per request

export async function getIsRedactedByIdentifiers(identifiers: string[]): Promise<{ [key: string]: boolean }> {
  try {
    if (identifiers.length === 0) return {};
    console.log("Getting redacted mapping from DB for identifiers:", identifiers.length, "items");

    const result = {} as Record<string, boolean>;

    for (let i = 0; i < identifiers.length; i += BATCH_GET_MAX_KEYS) {
      const batch = identifiers.slice(i, i + BATCH_GET_MAX_KEYS);
      const keys = batch.map((identifier) => ({
        identifier: { S: identifier },
      }));

      const dynamoRequest = await dynamoDBClient.send(
        new BatchGetItemCommand({
          RequestItems: {
            [Table.Redacted.tableName]: {
              Keys: keys,
            },
          },
        }),
      );

      const dynamoResults = dynamoRequest.Responses![Table.Redacted.tableName] ?? [];
      dynamoResults.forEach((item) => {
        if (item.identifier?.S) {
          result[item.identifier.S] = item.redacted?.N === "1";
        }
      });
    }

    return result;
  } catch (error) {
    console.error("Error getting redacted mapping from DB for identifiers:", identifiers, error);
    throw error;
  }
}

export async function getIsRedactedProductByProductIds(productIds: string[]): Promise<{ [key: string]: boolean }> {
  try {
    if (productIds.length === 0) return {};
    console.log("Getting redacted products mapping from DB for productIds:", productIds.length, "items");

    const result = {} as Record<string, boolean>;

    for (let i = 0; i < productIds.length; i += BATCH_GET_MAX_KEYS) {
      const batch = productIds.slice(i, i + BATCH_GET_MAX_KEYS);
      const keys = batch.map((productId) => ({
        productId: { S: productId },
      }));

      const dynamoRequest = await dynamoDBClient.send(
        new BatchGetItemCommand({
          RequestItems: {
            [Table.RedactedProducts.tableName]: {
              Keys: keys,
            },
          },
        }),
      );

      const dynamoResults = dynamoRequest.Responses![Table.RedactedProducts.tableName] ?? [];
      dynamoResults.forEach((item) => {
        if (item.productId?.S) {
          result[item.productId.S] = item.redacted?.N === "1";
        }
      });
    }

    return result;
  } catch (error) {
    console.error("Error getting redacted mapping from DB for productIds:", productIds, error);
    throw error;
  }
}
