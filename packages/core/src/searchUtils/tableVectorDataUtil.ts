// src/consumer.ts
// import fs
import {
  DynamoDBClient,
  Get,
  GetItemCommand,
  PutItemCommand,
  BatchGetItemCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { Config } from "sst/node/config";
import { Table } from "sst/node/table";

export interface IS3PathMap {
  score: number;
  s3Path: string;
  s3MapItemId: string;
  keyId: string;
  docBody?: any;
  status: "success" | "error";
  timestamp?: number; // Optional timestamp for tracking when record was created
}

const dynamoDBClient = new DynamoDBClient({});

// Use environment variables for AWS credentials and configuration
export async function writeVectorMappingToDB(vectorId: string, s3Path: string) {
  console.log(">>>Writing vector mapping to DynamoDB..", vectorId, typeof vectorId, "-->", s3Path);
  const timestamp = Date.now(); // Current timestamp in milliseconds

  await dynamoDBClient.send(
    new PutItemCommand({
      // TableName: Config.DYNAMO_MILVUSMAP_TABLE_NAME,
      TableName: Table.vectorToDataMap.tableName,
      Item: {
        [Config.DYNAMO_MILVUSMAP_KEY_NAME]: { S: vectorId },
        [Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME]: { S: JSON.stringify({ s3Path }) },
        timestamp: { N: timestamp.toString() },
        type: { S: "declaration" }, // Constant value for GSI partitioning
      },
    }),
  );
  console.log(">>>SUCCESS: DynamoDB..", vectorId, "-->", s3Path, "timestamp:", timestamp);
}
export async function getS3PathByVectorId(vectorId: string): Promise<string> {
  console.log("Getting vector mapping from DB..");
  const pathRow = await dynamoDBClient.send(
    new GetItemCommand({
      // TableName: Config.DYNAMO_MILVUSMAP_TABLE_NAME,
      TableName: Table.vectorToDataMap.tableName,
      Key: { [Config.DYNAMO_MILVUSMAP_KEY_NAME]: { S: vectorId } },
    }),
  );
  const val = pathRow.Item?.[Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME].S || JSON.stringify({ s3Path: "" });
  return JSON.parse(val).s3Path;
}

export async function getBatchS3PathsByVectorIds(
  vectorIds: { itemId: string; score: number }[],
): Promise<IS3PathMap[]> {
  if (vectorIds.length === 0) {
    console.log("getBatchS3PathsByVectorIds: No vector ids to get paths for..");
    return [];
  }
  console.log("Getting batch vector mapping from DB..", vectorIds);
  // user BatchGetItemCommand
  const keys = vectorIds.map((vectorId) => ({
    [Config.DYNAMO_MILVUSMAP_KEY_NAME]: { S: vectorId.itemId },
  }));
  console.log("query keys:", keys);
  const dynamoQuery = await dynamoDBClient.send(
    new BatchGetItemCommand({
      RequestItems: {
        [Table.vectorToDataMap.tableName]: {
          Keys: keys,
        },
      },
    }),
  );
  console.log("paths:", dynamoQuery);
  const dynamoResults = dynamoQuery.Responses![Table.vectorToDataMap.tableName];
  const asyncPathRequests = dynamoResults.map(async (resultRow) => {
    // const val = resultRow[Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME].S;
    // const jsonVal =  JSON.parse(val!); //{s3Path:string, ItemID:string}
    console.log("About to parse dynamo result row:", resultRow);
    return {
      ItemID: resultRow.ItemID.S!,
      s3Path: JSON.parse(resultRow[Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME].S!).s3Path,
    };
  });
  const results = await Promise.all(asyncPathRequests);
  console.log("dynamodb results:", results);
  let mappedResults: IS3PathMap[] = [];
  for (let i = 0; i < results.length; i++) {
    const matchingVectorId = vectorIds.find((v) => v.itemId === results[i].ItemID);
    mappedResults.push({
      score: matchingVectorId!.score,
      status: "success",
      keyId: matchingVectorId!.itemId,
      s3Path: results[i].s3Path,
      s3MapItemId: results[i].ItemID,
    });
  }
  return mappedResults;
}

export async function getLatest100S3Paths(): Promise<IS3PathMap[]> {
  console.log("Getting latest 100 vector mappings from DynamoDB table using timestamp GSI...");

  try {
    // Query the GSI with timestamp in descending order to get the latest records
    const queryResult = await dynamoDBClient.send(
      new QueryCommand({
        TableName: Table.vectorToDataMap.tableName,
        IndexName: "timestampIndex",
        KeyConditionExpression: "#type = :typeValue",
        ExpressionAttributeNames: {
          "#type": "type",
          "#itemId": Config.DYNAMO_MILVUSMAP_KEY_NAME,
          "#s3Path": Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME,
          "#timestamp": "timestamp",
        },
        ExpressionAttributeValues: {
          ":typeValue": { S: "declaration" },
        },
        ProjectionExpression: "#itemId, #s3Path, #timestamp",
        ScanIndexForward: false, // Descending order (latest first)
        Limit: 100,
      }),
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      console.log("No items found in vectorToDataMap table");
      return [];
    }

    console.log(`Found ${queryResult.Items.length} latest items in vectorToDataMap table`);

    // Convert DynamoDB items to IS3PathMap format
    const mappedResults: IS3PathMap[] = queryResult.Items.map((item) => {
      const itemId = item[Config.DYNAMO_MILVUSMAP_KEY_NAME].S!;
      const s3PathData = JSON.parse(item[Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME].S!);
      const timestamp = parseInt(item.timestamp.N!);

      return {
        score: 0, // No distance since this isn't a similarity search
        status: "success" as const,
        keyId: itemId,
        s3Path: s3PathData.s3Path,
        s3MapItemId: itemId,
        timestamp: timestamp, // Include timestamp in the result
      };
    });

    console.log(`Returning latest ${mappedResults.length} items from vectorToDataMap table (newest first)`);
    return mappedResults;
  } catch (error) {
    console.error("Error getting latest 100 S3 paths from DynamoDB:", error);
    throw error;
  }
}

export async function getRandom50S3Paths(): Promise<IS3PathMap[]> {
  console.log("Getting random vector mappings from DynamoDB table (fetching 200 for filtering)...");

  try {
    // First, scan to get all items (we'll use pagination if needed)
    const scanResult = await dynamoDBClient.send(
      new ScanCommand({
        TableName: Table.vectorToDataMap.tableName,
        FilterExpression: "#type = :typeValue",
        ExpressionAttributeNames: {
          "#type": "type",
          "#itemId": Config.DYNAMO_MILVUSMAP_KEY_NAME,
          "#s3Path": Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME,
          "#timestamp": "timestamp",
        },
        ExpressionAttributeValues: {
          ":typeValue": { S: "declaration" },
        },
        ProjectionExpression: "#itemId, #s3Path, #timestamp",
      }),
    );

    if (!scanResult.Items || scanResult.Items.length === 0) {
      console.log("No items found in vectorToDataMap table");
      return [];
    }

    console.log(`Found ${scanResult.Items.length} total items in vectorToDataMap table`);

    // Generate 200 random indexes
    const totalCount = scanResult.Items.length;
    const sampleSize = Math.min(200, totalCount);
    const randomIndexes = new Set<number>();

    // Generate unique random indexes
    while (randomIndexes.size < sampleSize) {
      randomIndexes.add(Math.floor(Math.random() * totalCount));
    }

    // Map only the randomly selected items
    const randomItems: IS3PathMap[] = Array.from(randomIndexes).map((index) => {
      const item = scanResult.Items![index];
      const itemId = item[Config.DYNAMO_MILVUSMAP_KEY_NAME].S!;
      const s3PathData = JSON.parse(item[Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME].S!);
      const timestamp = parseInt(item.timestamp.N!);

      return {
        score: 0, // No distance since this isn't a similarity search
        status: "success" as const,
        keyId: itemId,
        s3Path: s3PathData.s3Path,
        s3MapItemId: itemId,
        timestamp: timestamp, // Include timestamp in the result
      };
    });

    console.log(`Returning ${randomItems.length} random items from vectorToDataMap table (will be filtered to 50)`);
    return randomItems;
  } catch (error) {
    console.error("Error getting random S3 paths from DynamoDB:", error);
    throw error;
  }
}
