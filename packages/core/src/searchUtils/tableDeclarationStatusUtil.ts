import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { Table } from "sst/node/table";

const dynamoDBClient = new DynamoDBClient({});

export type DeclarationStatusType = "pending" | "success" | "failed";

// Default threshold for stale pending declarations (1 hour in milliseconds)
export const STALE_PENDING_THRESHOLD_MS = 60 * 60 * 1000;

export interface DeclarationStatus {
  identifier: string;
  status: DeclarationStatusType;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Creates a new declaration status record with "pending" status
 */
export async function createPendingDeclarationStatus(identifier: string): Promise<void> {
  const now = Date.now();
  try {
    console.log(">>>Creating pending declaration status..", identifier);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.DeclarationStatus.tableName,
        Item: {
          identifier: { S: identifier },
          status: { S: "pending" },
          message: { S: "" },
          createdAt: { N: now.toString() },
          updatedAt: { N: now.toString() },
        },
      }),
    );
    console.log(">>>SUCCESS: Created pending declaration status..", identifier);
  } catch (error) {
    console.error(">>>ERROR: Failed to create pending declaration status..", identifier, error);
    throw error;
  }
}

/**
 * Updates a declaration status to "success"
 * Uses upsert behavior - creates the record if it doesn't exist
 */
export async function updateDeclarationStatusSuccess(identifier: string): Promise<void> {
  const now = Date.now();
  try {
    console.log(">>>Updating declaration status to success..", identifier);
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: Table.DeclarationStatus.tableName,
        Key: {
          identifier: { S: identifier },
        },
        // Use SET with if_not_exists for createdAt to create record if missing
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, message = :message, createdAt = if_not_exists(createdAt, :now)",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": { S: "success" },
          ":updatedAt": { N: now.toString() },
          ":message": { S: "Declaration processed successfully" },
          ":now": { N: now.toString() },
        },
      }),
    );
    console.log(">>>SUCCESS: Updated declaration status to success..", identifier);
  } catch (error) {
    console.error(">>>ERROR: Failed to update declaration status to success..", identifier, error);
    throw error;
  }
}

/**
 * Updates a declaration status to "failed" with an error message
 * Uses upsert behavior - creates the record if it doesn't exist
 */
export async function updateDeclarationStatusFailed(identifier: string, errorMessage: string): Promise<void> {
  const now = Date.now();
  try {
    console.log(">>>Updating declaration status to failed..", identifier, errorMessage);
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: Table.DeclarationStatus.tableName,
        Key: {
          identifier: { S: identifier },
        },
        // Use SET with if_not_exists for createdAt to create record if missing
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, message = :message, createdAt = if_not_exists(createdAt, :now)",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": { S: "failed" },
          ":updatedAt": { N: now.toString() },
          ":message": { S: errorMessage },
          ":now": { N: now.toString() },
        },
      }),
    );
    console.log(">>>SUCCESS: Updated declaration status to failed..", identifier);
  } catch (error) {
    console.error(">>>ERROR: Failed to update declaration status to failed..", identifier, error);
    throw error;
  }
}

/**
 * Gets a declaration status by identifier
 */
export async function getDeclarationStatusByIdentifier(identifier: string): Promise<DeclarationStatus | null> {
  console.log("Getting declaration status from DB..", identifier);
  try {
    const result = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: Table.DeclarationStatus.tableName,
        Key: { identifier: { S: identifier } },
      }),
    );

    if (!result.Item) {
      console.log("Declaration status not found for identifier:", identifier);
      return null;
    }

    return {
      identifier: result.Item.identifier.S || "",
      status: (result.Item.status.S || "pending") as DeclarationStatusType,
      message: result.Item.message?.S || "",
      createdAt: parseInt(result.Item.createdAt?.N || "0", 10),
      updatedAt: parseInt(result.Item.updatedAt?.N || "0", 10),
    };
  } catch (error) {
    console.error("Error getting declaration status:", identifier, error);
    throw error;
  }
}

/**
 * Finds all stale pending declarations (pending for longer than the threshold)
 * @param thresholdMs - Time in milliseconds after which a pending declaration is considered stale
 * @returns Array of stale declaration statuses
 */
export async function findStalePendingDeclarations(
  thresholdMs: number = STALE_PENDING_THRESHOLD_MS,
): Promise<DeclarationStatus[]> {
  const cutoffTime = Date.now() - thresholdMs;
  const staleDeclarations: DeclarationStatus[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  console.log(`Scanning for stale pending declarations (created before ${new Date(cutoffTime).toISOString()})...`);

  try {
    do {
      const result = await dynamoDBClient.send(
        new ScanCommand({
          TableName: Table.DeclarationStatus.tableName,
          FilterExpression: "#status = :pending AND createdAt < :cutoff",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":pending": { S: "pending" },
            ":cutoff": { N: cutoffTime.toString() },
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      if (result.Items) {
        for (const item of result.Items) {
          staleDeclarations.push({
            identifier: item.identifier?.S || "",
            status: (item.status?.S || "pending") as DeclarationStatusType,
            message: item.message?.S || "",
            createdAt: parseInt(item.createdAt?.N || "0", 10),
            updatedAt: parseInt(item.updatedAt?.N || "0", 10),
          });
        }
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Found ${staleDeclarations.length} stale pending declarations`);
    return staleDeclarations;
  } catch (error) {
    console.error("Error scanning for stale pending declarations:", error);
    throw error;
  }
}

/**
 * Marks a stale pending declaration as failed with a timeout message
 */
export async function markDeclarationAsTimedOut(identifier: string): Promise<void> {
  const now = Date.now();
  const timeoutMessage = "Declaration processing timed out - stuck in pending state";

  try {
    console.log(">>>Marking declaration as timed out..", identifier);
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: Table.DeclarationStatus.tableName,
        Key: {
          identifier: { S: identifier },
        },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt, message = :message",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": { S: "failed" },
          ":updatedAt": { N: now.toString() },
          ":message": { S: timeoutMessage },
        },
        // Only update if still pending (avoid race conditions)
        ConditionExpression: "#status = :pending",
      }),
    );
    console.log(">>>SUCCESS: Marked declaration as timed out..", identifier);
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      console.log("Declaration status already updated (not pending anymore):", identifier);
      return; // This is fine - status was already updated
    }
    console.error(">>>ERROR: Failed to mark declaration as timed out..", identifier, error);
    throw error;
  }
}

export interface CleanupResult {
  processed: number;
  successful: number;
  failed: number;
  errors: Array<{ identifier: string; error: string }>;
}

/**
 * Cleans up stale pending declarations by marking them as failed
 * @param thresholdMs - Time in milliseconds after which a pending declaration is considered stale
 * @returns Cleanup result with counts and any errors
 */
export async function cleanupStalePendingDeclarations(
  thresholdMs: number = STALE_PENDING_THRESHOLD_MS,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    processed: 0,
    successful: 0,
    failed: 0,
    errors: [],
  };

  try {
    const staleDeclarations = await findStalePendingDeclarations(thresholdMs);
    result.processed = staleDeclarations.length;

    for (const declaration of staleDeclarations) {
      try {
        await markDeclarationAsTimedOut(declaration.identifier);
        result.successful++;
      } catch (error: any) {
        result.failed++;
        result.errors.push({
          identifier: declaration.identifier,
          error: error.message || String(error),
        });
      }
    }

    console.log(`Cleanup complete: ${result.successful}/${result.processed} declarations marked as timed out`);
    if (result.failed > 0) {
      console.error(`Cleanup had ${result.failed} failures:`, result.errors);
    }

    return result;
  } catch (error) {
    console.error("Error during stale declarations cleanup:", error);
    throw error;
  }
}
