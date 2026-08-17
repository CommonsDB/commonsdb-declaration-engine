import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { Config } from "sst/node/config";

// Producer for the search service's index stream (a Kinesis stream owned by
// the sibling search deployment, physical name <stage>-commonsdb-serverless-search).
// The registry mints the item id, persists it in vectorToDataMap, and emits
// this event; the search service consumes it and indexes the ISCC under that
// id. Fire-and-forget: no response channel is needed.

export interface ISearchIndexEvent {
  /** Item id minted by the registry — the search service indexes under this key. */
  itemId: string;
  iscc: string;
  rayId?: string;
  timestamp: number;
}

const kinesisClient = new KinesisClient({});

/**
 * Emits an index event to the search index stream. Set the
 * SEARCH_INDEX_STREAM_NAME parameter to "_" to disable (stages without a
 * search deployment) — events are then logged and skipped.
 */
export async function sendToSearchIndexStream(event: ISearchIndexEvent): Promise<void> {
  const streamName = Config.SEARCH_INDEX_STREAM_NAME;
  if (!streamName || streamName === "_") {
    console.warn("Search index stream disabled (SEARCH_INDEX_STREAM_NAME=_) — skipping index event:", event.itemId);
    return;
  }

  console.log("Sending index event to search stream:", streamName, event.itemId, event.iscc);
  await kinesisClient.send(
    new PutRecordCommand({
      StreamName: streamName,
      PartitionKey: event.itemId,
      Data: Buffer.from(JSON.stringify(event)),
    }),
  );
  console.log("Index event sent:", event.itemId);
}
