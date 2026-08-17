import { PutRecordCommand, KinesisClient } from "@aws-sdk/client-kinesis";
import { IDeclarationPayload } from "../interfaces/commonInterfaces";
import { KinesisStream } from "sst/node/kinesis-stream";

const kinesisClient = new KinesisClient({});

/**
 * Publish a declaration payload onto the ingest Kinesis stream. The random
 * rayId is used as the partition key so records spread across shards and can be
 * processed in parallel; it is also returned so the caller can correlate logs.
 */
export async function sendRecord(data: IDeclarationPayload): Promise<{ success: boolean; rayId: string }> {
  const rayId = Math.random().toString(36).substring(2, 10);
  try {
    data.metaInternal.rayId = rayId;

    const command = new PutRecordCommand({
      Data: Buffer.from(JSON.stringify(data)),
      StreamName: KinesisStream.declarationStream.streamName,
      PartitionKey: rayId,
    });

    await kinesisClient.send(command);
    return { success: true, rayId };
  } catch (err) {
    console.error("Error sending record to Kinesis:", err);
    return { success: false, rayId };
  }
}
