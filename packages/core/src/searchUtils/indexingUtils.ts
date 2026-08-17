import { randomUUID } from "crypto";
import { _Record } from "@aws-sdk/client-kinesis";
import { writeCIDMappingToDB, writeDecIdMappingToDB } from "./tableCidsUtil";
import { saveJsonToS3 } from "./s3Util";
import { sendToSearchIndexStream } from "./searchIndexProducer";
import { Config } from "sst/node/config";
import { Table } from "sst/node/table";
import { notifySlack, shouldNotifySlack } from "./notifyUtil";
import { IDeclarationPayload } from "../interfaces/commonInterfaces";
import { writeVectorMappingToDB } from "./tableVectorDataUtil";
import { getIdentifierKeyValuePair } from "../utils/fieldMapping";
import { handleNewDeclaration, isNewUniqueIsccCode } from "./analyticsUtil";
import { syncDeclarationToStats } from "../statistics/statsSyncUtil";
import { formatIrohRegistryRecord, putToIrohRegistry } from "./irohRegistryUtil";

export async function processIsccStringRaw(
  isccString: string,
  companyId: string,
  payload: IDeclarationPayload,
): Promise<void> {
  // 1) mint itemId + emit index event  --> search index Kinesis stream (consumed by the search service)
  // 2) save to s3        --> (input: payload,)   --> get: s3Path
  // 3) save to dynamodb  --> (input: itemId, s3Path) --> get: success
  // 4) save to dynamodb (CIDs)  --> (input: CID, content) --> get: success
  try {
    console.log("Indexer: Processing RayID:", payload.metaInternal.rayId, "ISCC:", isccString);
    // The registry mints the item id; the search service indexes the ISCC
    // under it asynchronously. A failure to emit MUST propagate — it drives
    // the Kinesis retry of this declaration record.
    const vectorId = randomUUID();
    await sendToSearchIndexStream({
      itemId: vectorId,
      iscc: isccString,
      rayId: payload.metaInternal.rayId,
      timestamp: Date.now(),
    });
    console.log(
      "Indexer: Emitted search index event:, rayId:",
      payload.metaInternal.rayId,
      "ISCC:",
      isccString,
      "ItemId:",
      vectorId,
    );

    const mappedS3Path = await saveJsonToS3({
      isccCode: isccString,
      companyId: companyId,
      rayId: payload.metaInternal.rayId || "MISSING_RAY_ID",
      mappingInfo: {
        table: Table.vectorToDataMap.tableName,
        mapKey: Config.DYNAMO_MILVUSMAP_KEY_NAME,
        attribute: Config.DYNAMO_MILVUSMAP_ATTRIBUTE_NAME,
        db: "dynamodb",
      },
      vectorInfo: {
        id: vectorId,
        storageDb: "search-service",
        storageHost: Config.SEARCH_INDEX_STREAM_NAME,
      },
      data: payload,
    });
    console.log(
      "Indexer: Saved to S3:, rayId:",
      payload.metaInternal.rayId,
      "ISCC:",
      isccString,
      "S3Path:",
      mappedS3Path,
    );

    await writeVectorMappingToDB(vectorId, mappedS3Path);
    console.log(
      "Indexer: Saved to DynamoDB:, rayId:",
      payload.metaInternal.rayId,
      "ISCC:",
      isccString,
      "VectorId:",
      vectorId,
      "S3Path:",
      mappedS3Path,
    );

    const [fieldKey, fieldValue] = getIdentifierKeyValuePair(payload.metaInternal);

    if (fieldValue && payload.declarationMetadata?.publicMetadata) {
      const cidContent = payload.declarationMetadata.publicMetadata;

      // await writeCIDMappingToDB(fieldValue, cidContent, mappedS3Path);
      console.log("identifier", fieldKey, fieldValue);
      await writeDecIdMappingToDB(fieldValue, cidContent, mappedS3Path);

      // Update analytics counters for real-time tracking
      try {
        const declarerId = payload.metaInternal.declarerId || "unknown";
        const isNewUnique = await isNewUniqueIsccCode(isccString);
        await handleNewDeclaration(declarerId, isccString, isNewUnique);
        console.log("Analytics counters updated for declaration:", payload.metaInternal.rayId);
      } catch (analyticsError) {
        console.error("Error updating analytics counters (non-blocking):", analyticsError);
        // Continue processing even if analytics update fails
      }

      // Mirror the declaration into the iroh registry via its external
      // ingestion Kinesis stream (best-effort). A failure here must NOT fail
      // the record: the registry-side ingestion is idempotent, so the
      // backfill script (scripts/backfillIrohRegistry.ts) reconciles any
      // missed declarations on its next run.
      try {
        await putToIrohRegistry(formatIrohRegistryRecord(fieldValue, payload, mappedS3Path));
      } catch (irohRegistryError) {
        console.error("Error mirroring declaration to iroh registry (non-blocking):", irohRegistryError);
      }

      // Sync the declaration into the cdb_stats Postgres DB + DynamoDB de-dup
      // table (best-effort). A failure here must NOT fail the record: the file
      // is left unmarked so the commons-db-statistics batch pipeline reconciles
      // it on its next run. Materialized views are refreshed on a schedule, not
      // here, so the hot path stays cheap.
      try {
        await syncDeclarationToStats({
          connectionString: Config.SECRET_CDB_STATS_PG_URL,
          dynamoTable: Config.CDB_STATS_DYNAMO_TABLE,
          s3Path: mappedS3Path,
          payload,
        });
        console.log("Stats sync complete for declaration:", payload.metaInternal.rayId);
      } catch (statsSyncError) {
        console.error("Error syncing declaration to cdb_stats (non-blocking):", statsSyncError);
      }

      if (await shouldNotifySlack(companyId)) {
        await notifySlack({
          message: "ISCC Added",
          rayId: payload.metaInternal.rayId,
          env: Config.STAGE,
          [fieldKey]: fieldValue || "MISSING_IDENTIFIER",
          companyId: companyId,
          iscc: isccString,
          publicMetadataWithCID: convertCidToCidUrl(fieldValue),
          s3RawFullData: convertS3UrlForNotification(mappedS3Path),
        });
      }
    } else {
      console.log("It was not possible to write CID mapping to DB due to missing 'cid' or 'publicMetadata':", payload);
      throw new Error("It was not possible to write CID mapping to DB due to missing 'cid' or 'publicMetadata'");
    }
  } catch (err: any) {
    console.error("Error processing iscc:", err);
    // Notify slack but don't let notification failure block error propagation
    try {
      await notifySlack(
        {
          message: "ERROR processing ISCC",
          rayId: payload.metaInternal.rayId,
          errMessage: err.message ? err.message : "No error message",
          env: Config.STAGE,
          companyId: companyId,
          iscc: isccString,
          error: err,
        },
        "error",
      );
    } catch (notifyErr) {
      console.error("Failed to notify Slack about processing error:", notifyErr);
    }
    // Re-throw to ensure caller knows processing failed
    throw err;
  }
}

function convertCidToCidUrl(cid: string): string {
  const baseUrl = "https://api.commonsdb.org/v1/metadata-pub/"; // commonsdb.org
  return `${baseUrl}${cid}`;
}

function convertS3UrlForNotification(s3Url: string): string {
  // Extract the bucket name and key from the S3 URL
  const [bucketName, ...keyParts] = s3Url.replace("s3://", "").split("/");
  const key = keyParts.join("/");

  // URL encode the key
  const encodedKey = encodeURIComponent(key);

  // Construct the desired URL
  const region = "eu-central-1";
  const desiredUrl = `https://${region}.console.aws.amazon.com/s3/object/${bucketName}?region=${region}&bucketType=general&prefix=${encodedKey}`;

  return desiredUrl;
}
