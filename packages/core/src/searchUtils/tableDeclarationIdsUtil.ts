// src/consumer.ts
// import fs
import {
  DynamoDBClient,
  Get,
  GetItemCommand,
  PutItemCommand,
  BatchGetItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { Config } from "sst/node/config";
import { Table } from "sst/node/table";
import { IDeclarationPublicMetadata } from "../interfaces/commonInterfaces";

const dynamoDBClient = new DynamoDBClient({
  // region: Config.AWS_REGION,
  // credentials: {
  //   accessKeyId: Config.SECRET_AWS_ACCESS_KEY_ID!,
  //   secretAccessKey: Config.SECRET_AWS_SECRET_ACCESS_KEY!
  // }
});

// Use environment variables for AWS credentials and configuration
// TO-DO: function is not invoked. Check if it's needed
export async function __writeDeclarationIdPathToDB(identifier: string, s3Path: string) {
  try {
    //@ts-ignore
    console.log(">>>Writing identifier mapping to DynamoDB..", identifier, "-->", "s3Path: ", "hidden" || s3Path);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.IdentifiersOfDeclaration.tableName,
        Item: {
          identifier: { S: identifier },
          S3Path: { S: s3Path },
        },
      }),
    );
    //@ts-ignore
    console.log(">>>SUCCESS: DynamoDB..", identifier, "-->", "s3Path: ", "hidden" || s3Path);
  } catch (error) {
    console.error(">>>ERROR: Failed to write identifier mapping to DynamoDB..", identifier, "-->", s3Path, error);
  }
}

// TO-DO: function is not invoked. Check if it's needed
export async function __getS3PathByDeclarationId(identifier: string): Promise<string> {
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
    return result.Item?.S3Path.S || "";
  } catch (error) {
    console.error(">>>ERROR: Failed to get identifier mapping from DynamoDB..", identifier, error);
    return "";
  }
}

export async function countIdentifiersOfDeclarationRecords(): Promise<number> {
  try {
    console.log(
      `Counting total records in IdentifiersOfDeclaration table: ${Table.IdentifiersOfDeclaration.tableName}`,
    );

    let totalCount = 0;
    let lastEvaluatedKey: any = undefined;

    do {
      const scanCommand = new ScanCommand({
        TableName: Table.IdentifiersOfDeclaration.tableName,
        Select: "COUNT", // Only return the count, not the actual items
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const response = await dynamoDBClient.send(scanCommand);

      if (response.Count) {
        totalCount += response.Count;
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
      console.log(`Scanned batch, found ${response.Count} records. Total so far: ${totalCount}`);
    } while (lastEvaluatedKey);

    console.log(`Total records in IdentifiersOfDeclaration table: ${totalCount}`);
    return totalCount;
  } catch (error) {
    console.error("Error counting records in IdentifiersOfDeclaration table:", error);
    throw error;
  }
}
