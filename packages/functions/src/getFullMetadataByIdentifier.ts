import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { getMultipleJsonsFromS3ByPath, getAllDeclarersInBucket } from "@commonsdb/core/searchUtils/s3Util";
import { IS3PathMap } from "@commonsdb/core/searchUtils/tableVectorDataUtil";
import { IDeclarationPayload, IDeclarationPublicMetadata } from "@commonsdb/core/interfaces/commonInterfaces";
import {
  getIsRedactedByIdentifiers,
  getIsRedactedProductByProductIds,
} from "@commonsdb/core/searchUtils/tableRedactedUtil";
import { getIdentifierKeyValuePair, IdentifierFieldValuesType } from "@commonsdb/core/utils/fieldMapping";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { Table } from "sst/node/table";
import { Bucket } from "sst/node/bucket";

const dynamoDBClient = new DynamoDBClient({});

async function searchForJsonFileInS3(isccCode: string, identifier: string): Promise<string | null> {
  console.log(`Searching for file with ISCC: ${isccCode} and identifier: ${identifier}`);

  try {
    // Get all declarers (first-level folders) dynamically from S3 bucket
    console.log("Getting all declarers from S3 bucket...");
    const allDeclarers = await getAllDeclarersInBucket();
    console.log(`Found ${allDeclarers.length} declarers: ${allDeclarers.join(", ")}`);

    for (const declarerId of allDeclarers) {
      // Create potential S3 path using dynamic bucket name
      const potentialS3Path = `s3://${Bucket.declarationData.bucketName}/${declarerId}/${isccCode}/${identifier}.json`;

      // Try to get the file using existing S3 utility
      const s3PathMap: IS3PathMap = {
        s3Path: potentialS3Path,
        s3MapItemId: identifier,
        keyId: identifier,
        score: 0,
        status: "error", // Will be updated to "success" if file is found
      };

      try {
        const result = await getMultipleJsonsFromS3ByPath([s3PathMap]);
        if (result.length > 0 && result[0].status === "success" && result[0].docBody) {
          console.log(`Found file at: ${potentialS3Path}`);
          return potentialS3Path;
        }
      } catch (error) {
        // File doesn't exist under this declarer, continue searching
        console.log(`File not found at: ${potentialS3Path}`);
      }
    }

    console.log(
      `No file found for ISCC: ${isccCode} and identifier: ${identifier} across ${allDeclarers.length} declarers`,
    );
    return null;
  } catch (error) {
    console.error("Error searching for JSON file in S3:", error);
    return null;
  }
}

async function getS3PathByIdentifier(identifier: string): Promise<string> {
  try {
    console.log("Getting identifier mapping from DB for identifier:", identifier);
    const result = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: Table.IdentifiersOfDeclaration.tableName,
        Key: {
          identifier: { S: identifier },
        },
      }),
    );

    console.log(">>>SUCCESS: Got identifier mapping from DB for identifier:", identifier);
    console.log(">>>SUCCESS: Got identifier mapping from DB for result:", result);

    // If record doesn't exist, return empty string
    if (!result.Item) {
      console.log(`No record found for identifier: ${identifier}`);
      return "";
    }

    // Check for existing S3Path
    const existingS3Path = result.Item.s3Path?.S || "";
    if (existingS3Path) {
      console.log(`Found existing s3Path for identifier ${identifier}: ${existingS3Path}`);
      return existingS3Path;
    }

    // S3Path doesn't exist, try to cure it by extracting ISCC from content
    const contentString = result.Item.content?.S;
    if (!contentString) {
      console.log(`No content field found for identifier: ${identifier}`);
      return "";
    }

    try {
      const content: IDeclarationPublicMetadata = JSON.parse(contentString);
      const isccCode = content.iscc;

      if (!isccCode || !isccCode.startsWith("ISCC:")) {
        console.log(`Invalid or missing ISCC code in content for identifier: ${identifier}`);
        return "";
      }

      console.log(`Extracted ISCC code: ${isccCode} for identifier: ${identifier}`);

      // Search for the file in S3 across common declarers
      const foundS3Path = await searchForJsonFileInS3(isccCode, identifier);

      if (foundS3Path) {
        // Update the record with the found S3 path (cure it)
        try {
          console.log(`Updating s3Path for identifier ${identifier} to ${foundS3Path}`);

          await dynamoDBClient.send(
            new UpdateItemCommand({
              TableName: Table.IdentifiersOfDeclaration.tableName,
              Key: {
                identifier: { S: identifier },
              },
              UpdateExpression: "SET s3Path = :s3Path",
              ExpressionAttributeValues: {
                ":s3Path": { S: foundS3Path },
              },
            }),
          );

          console.log(`Successfully updated s3Path for identifier: ${identifier}`);
        } catch (updateError) {
          console.error(`Failed to update s3Path for identifier ${identifier}:`, updateError);
          // Don't throw error, just log it and return the found path anyway
        }

        return foundS3Path;
      } else {
        console.log(`Could not find S3 file for identifier: ${identifier} with ISCC: ${isccCode}`);
        return "";
      }
    } catch (parseError) {
      console.error(`Failed to parse content field for identifier ${identifier}:`, parseError);
      return "";
    }
  } catch (error) {
    console.error(">>>ERROR: Failed to get identifier mapping from DynamoDB..", identifier, error);
    return "";
  }
}

export const getFullMetadataByIdentifier = ApiHandler(async (_evt) => {
  console.log("getFullMetadataByIdentifier called:");
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }
  console.log(Config.VERSION);

  const [fieldKey] = getIdentifierKeyValuePair();
  const fieldValue = _evt.queryStringParameters?.["cid"];
  console.log("identifier", fieldKey, fieldValue);

  if (!fieldValue) {
    return { statusCode: 400, body: `Invalid request (missing identifier)` };
  }

  try {
    // Get S3 path for the identifier
    const s3Path = await getS3PathByIdentifier(fieldValue);
    if (!s3Path) {
      // Return empty results if not found
      return {
        statusCode: 200,
        body: JSON.stringify(
          {
            q: fieldValue,
            invalidCount: 0,
            version: Config.VERSION,
            results: [],
          },
          null,
          2,
        ),
      };
    }

    // Create IS3PathMap structure to work with existing S3 utility
    const s3PathMap: IS3PathMap[] = [
      {
        s3Path: s3Path,
        s3MapItemId: fieldValue,
        keyId: fieldValue,
        score: 0, // Perfect match
        status: "success",
      },
    ];

    console.log("get json from s3 by path", s3PathMap);
    const s3ResultsWithDocBody: IS3PathMap[] = await getMultipleJsonsFromS3ByPath(s3PathMap);

    // Check if we got valid results
    const validResults = s3ResultsWithDocBody.filter(
      (doc) => doc !== undefined && doc.docBody && doc.status === "success",
    );
    if (validResults.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify(
          {
            q: fieldValue,
            invalidCount: 1,
            version: Config.VERSION,
            results: [],
          },
          null,
          2,
        ),
      };
    }

    const docResult = validResults[0];
    const docBody: IDeclarationPayload = docResult.docBody;

    // Apply the same redaction checks as the original function
    const areRedactedProductMap = await getIsRedactedProductByProductIds(
      [docBody.declarationMetadata.publicMetadata.entryUUID || ""].filter((i) => !!i),
    );
    console.log("getFullMetadataByIdentifier redactedProductQueryMap: ", areRedactedProductMap);

    const areRedactedMap = await getIsRedactedByIdentifiers(
      [docBody.metaInternal?.[fieldKey as IdentifierFieldValuesType] || ""].filter((i) => !!i),
    );
    console.log("getFullMetadataByIdentifier redactedQueryMap: ", areRedactedMap);

    // Apply the same filtering logic
    const isAfterTimestamp =
      new Date(docBody.declarationMetadata.publicMetadata.timestamp) > new Date(Config.MIN_DECLARATION_TIMESTAMP);
    const isNotRedactedProduct = !areRedactedProductMap[docBody.declarationMetadata.publicMetadata.entryUUID || ""];
    const isNotRedacted = !areRedactedMap[docBody.metaInternal?.[fieldKey as IdentifierFieldValuesType] || ""];

    let results: IS3PathMap[] = [];

    if (isAfterTimestamp && isNotRedactedProduct && isNotRedacted) {
      // Apply censoring logic like the original function
      const censored: IS3PathMap = {
        ...docResult,
        docBody: {
          ...docResult.docBody,
          metaInternal: {
            rayId: docBody.metaInternal.rayId || "",
            cid: docBody.metaInternal.cid || "",
            [fieldKey]: docBody.metaInternal[fieldKey as IdentifierFieldValuesType] || "",
            declarationId: docBody.metaInternal.declarationId || "",
            isccCode: docBody.metaInternal.isccCode || "",
          },
          declarationMetadata: {
            publicMetadata: docBody.declarationMetadata.publicMetadata,
            //we might have private metadata here so we need to filter it out
          },
        },
      };

      if (docBody.declarationMetadata.commonsDbRegistry) {
        censored.docBody.declarationMetadata.commonsDbRegistry = {
          ...docBody.declarationMetadata.commonsDbRegistry,
        };
      }

      results = [censored];
    }

    const willReturn = {
      statusCode: 200,
      body: JSON.stringify(
        {
          q: fieldValue,
          invalidCount: s3ResultsWithDocBody.length - validResults.length,
          version: Config.VERSION,
          results: results,
        },
        null,
        2,
      ),
    };
    console.log("will return getFullMetadataByIdentifier:", willReturn);
    console.log("custom-logs: ", _evt.headers["custom-log"]);
    return willReturn;
  } catch (err) {
    console.error("Error getting declaration by identifier:", err);
    // Return empty results on error
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          q: fieldValue,
          invalidCount: 1,
          version: Config.VERSION,
          results: [],
        },
        null,
        2,
      ),
    };
  }
});
