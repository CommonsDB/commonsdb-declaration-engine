import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Table } from "sst/node/table";

const dynamoDBClient = new DynamoDBClient({});

export interface SupersededInfo {
  identifier: string;
  supersededBy: string;
  supersededAt: number;
}

export interface DeclarationInfo {
  exists: boolean;
  declarerId?: string;
  content?: any;
}

/**
 * Gets declaration info from the registry (IdentifiersOfDeclaration table)
 * @param identifier - The CIDv1 identifier of the declaration to check
 * @returns DeclarationInfo with existence status and declarerId if found
 */
export async function getDeclarationInfo(identifier: string): Promise<DeclarationInfo> {
  console.log("[SupersededUtil] Getting declaration info:", identifier);
  try {
    const result = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: Table.IdentifiersOfDeclaration.tableName,
        Key: { identifier: { S: identifier } },
      }),
    );

    if (!result.Item) {
      console.log(`[SupersededUtil] Declaration ${identifier} not found`);
      return { exists: false };
    }

    // Parse the content to get the declarerId
    const contentStr = result.Item.content?.S;
    let declarerId: string | undefined;
    let content: any;

    if (contentStr) {
      try {
        content = JSON.parse(contentStr);
        declarerId = content?.declarerId;
        console.log(`[SupersededUtil] Declaration ${identifier} found, declarerId: ${declarerId}`);
      } catch (parseError) {
        console.error("[SupersededUtil] Error parsing declaration content:", parseError);
      }
    }

    return { exists: true, declarerId, content };
  } catch (error) {
    console.error("[SupersededUtil] Error getting declaration info:", identifier, error);
    throw error;
  }
}

/**
 * Checks if a declaration exists in the registry (IdentifiersOfDeclaration table)
 * @param identifier - The CIDv1 identifier of the declaration to check
 * @returns true if the declaration exists, false otherwise
 */
export async function checkDeclarationExists(identifier: string): Promise<boolean> {
  const info = await getDeclarationInfo(identifier);
  return info.exists;
}

/**
 * Checks if a declaration has already been superseded by another declaration
 * @param identifier - The CIDv1 identifier of the declaration to check
 * @returns SupersededInfo if superseded, null otherwise
 */
export async function getSupersededInfo(identifier: string): Promise<SupersededInfo | null> {
  console.log("[SupersededUtil] Checking if declaration is superseded:", identifier);
  try {
    const result = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: Table.SupersededDeclarations.tableName,
        Key: { identifier: { S: identifier } },
      }),
    );

    if (!result.Item) {
      console.log(`[SupersededUtil] Declaration ${identifier} is not superseded`);
      return null;
    }

    const supersededInfo: SupersededInfo = {
      identifier: result.Item.identifier.S || "",
      supersededBy: result.Item.supersededBy.S || "",
      supersededAt: parseInt(result.Item.supersededAt?.N || "0", 10),
    };

    console.log(
      `[SupersededUtil] Declaration ${identifier} was superseded by ${supersededInfo.supersededBy} at ${supersededInfo.supersededAt}`,
    );
    return supersededInfo;
  } catch (error) {
    console.error("[SupersededUtil] Error checking superseded status:", identifier, error);
    throw error;
  }
}

/**
 * Marks a declaration as superseded by another declaration
 * @param supersededIdentifier - The CIDv1 identifier of the declaration being superseded
 * @param supersedingIdentifier - The CIDv1 identifier of the new declaration that supersedes
 */
export async function markAsSuperseded(supersededIdentifier: string, supersedingIdentifier: string): Promise<void> {
  console.log(`[SupersededUtil] Marking declaration ${supersededIdentifier} as superseded by ${supersedingIdentifier}`);
  const now = Date.now();

  try {
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.SupersededDeclarations.tableName,
        Item: {
          identifier: { S: supersededIdentifier },
          supersededBy: { S: supersedingIdentifier },
          supersededAt: { N: now.toString() },
        },
      }),
    );
    console.log(
      `[SupersededUtil] Successfully marked ${supersededIdentifier} as superseded by ${supersedingIdentifier}`,
    );
  } catch (error) {
    console.error("[SupersededUtil] Error marking declaration as superseded:", supersededIdentifier, error);
    throw error;
  }
}

/**
 * Validates supersedes field for a new declaration
 * Returns validation result with specific error message if invalid
 *
 * Validation rules:
 * 1. The referenced declaration must exist in the registry
 * 2. The referenced declaration must not already be superseded by another declaration
 * 3. Only the original declarer can supersede their own declaration (security measure)
 *
 * @param supersedes - The CIDv1 identifier of the declaration to supersede
 * @param newDeclarerIdThe declarerId of the new declaration attempting to supersede
 * @returns Object with valid boolean and optional error message
 */
export async function validateSupersedes(
  supersedes: string,
  newDeclarerId: string,
): Promise<{ valid: boolean; error?: string; existingSupersededBy?: string; originalDeclarerId?: string }> {
  console.log("[SupersededUtil] Validating supersedes field:", supersedes, "by declarerId:", newDeclarerId);

  // Check if the declaration to supersede exists and get its declarerId
  const declarationInfo = await getDeclarationInfo(supersedes);
  if (!declarationInfo.exists) {
    return {
      valid: false,
      error: `Cannot supersede declaration '${supersedes}': declaration does not exist in the registry`,
    };
  }

  // Check if the new declarer is the same as the original declarer
  // This is a critical security check to prevent unauthorized superseding
  const originalDeclarerId = declarationInfo.declarerId;
  if (originalDeclarerId && originalDeclarerId !== newDeclarerId) {
    console.error(`[SupersededUtil] Declarer mismatch: original=${originalDeclarerId}, new=${newDeclarerId}`);
    return {
      valid: false,
      error: `Cannot supersede declaration '${supersedes}': only the original declarer can supersede their own declaration`,
      originalDeclarerId,
    };
  }

  // Check if the declaration has already been superseded
  const supersededInfo = await getSupersededInfo(supersedes);
  if (supersededInfo) {
    return {
      valid: false,
      error: `Cannot supersede declaration '${supersedes}': it has already been superseded by '${supersededInfo.supersededBy}'`,
      existingSupersededBy: supersededInfo.supersededBy,
    };
  }

  console.log("[SupersededUtil] Supersedes validation passed for:", supersedes);
  return { valid: true };
}
