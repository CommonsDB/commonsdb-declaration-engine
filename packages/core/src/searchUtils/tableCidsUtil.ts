// src/consumer.ts
// import fs
import { DynamoDBClient, Get, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Config } from "sst/node/config";
import { Table } from "sst/node/table";
import { IDeclarationPublicMetadata } from "../interfaces/commonInterfaces";

const dynamoDBClient = new DynamoDBClient({});

export async function writeCIDMappingToDB(identifier: string, content: IDeclarationPublicMetadata, s3Path: string) {
  try {
    console.log(">>>Writing identifier mapping to DynamoDB..", identifier, "-->", content);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.CIDs.tableName,
        Item: {
          identifier: { S: identifier },
          content: { S: JSON.stringify(content) },
          s3Path: { S: s3Path },
        },
      }),
    );
    console.log(">>>SUCCESS: DynamoDB..", identifier, "-->", content);
  } catch (error) {
    console.error(">>>ERROR: Failed to write identifier mapping to DynamoDB..", identifier, "-->", content, error);
  }
}

// rename to writeIdentifierOfDeclarationMappingToDB, remove cid
export async function writeDecIdMappingToDB(identifier: string, content: IDeclarationPublicMetadata, s3Path: string) {
  try {
    console.log(">>>Writing identifier mapping to DynamoDB..", identifier, "-->", content);
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: Table.IdentifiersOfDeclaration.tableName,
        Item: {
          identifier: { S: identifier },
          content: { S: JSON.stringify(content) },
          s3Path: { S: s3Path },
        },
      }),
    );
    console.log(">>>SUCCESS: DynamoDB..", identifier, "-->", content);
  } catch (error) {
    console.error(">>>ERROR: Failed to write identifier mapping to DynamoDB..", identifier, "-->", content, error);
  }
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

export async function getContentByCID(cid: string): Promise<string> {
  console.log("Getting CID mapping from DB..");
  const pathRow = await dynamoDBClient.send(
    new GetItemCommand({
      TableName: Table.CIDs.tableName,
      Key: { cid: { S: cid } },
    }),
  );
  const val = pathRow.Item?.content.S || "";
  return val;
}

export async function getContentByIdentifier(identifier: string): Promise<{ content: string; cid: string }> {
  console.log("Getting identifier mapping from DB.. ", identifier);
  const pathRow = await dynamoDBClient.send(
    new GetItemCommand({
      TableName: Table.IdentifiersOfDeclaration.tableName,
      Key: { identifier: { S: identifier } },
    }),
  );
  console.log("pathRow: ", pathRow);
  const val = pathRow.Item?.content.S || "";
  return { content: val, cid: pathRow.Item?.cid?.S || "" };
}
