// Producer side of the iroh-registry external ingestion stream
// (iroh-registry-api: documentation/15-external-ingestion.md). Declarations
// are mirrored into the registry by putting compact events onto a Kinesis
// stream in this same account; the registry's kinesis-ingest-bridge service
// consumes them. Three event kinds: put / redact / unredact.
import { KinesisClient, PutRecordCommand, PutRecordsCommand } from "@aws-sdk/client-kinesis";
import { Config } from "sst/node/config";
import { IDeclarationPayload } from "../interfaces/commonInterfaces";

let kinesisClient = new KinesisClient({});

/** Long-running scripts (backfill) can swap in a client with custom retry /
 * DNS-caching transport; the Lambda paths keep the default. */
export function setIrohRegistryKinesisClient(client: KinesisClient): void {
  kinesisClient = client;
}

const EVENT_SOURCE = "commonsdb-serverless";
// PutRecords hard limit is 500 records / 5 MB per call.
const PUT_RECORDS_BATCH_SIZE = 500;

export interface IIrohRegistryRecord {
  /** The declaration identifier (cidV1) — the registry key. */
  key: string;
  /** The registry value, already serialized. The registry content-hashes this
   * exact string for duplicate detection, so live traffic and backfill must
   * both produce it through formatIrohRegistryValue. */
  value: string;
}

// Stream name resolution: process.env first so the backfill script (which
// runs outside SST bindings) can point anywhere; otherwise the stack
// parameter. "_" is the disabled placeholder (SSM does not allow empty
// strings), used on stages that have no registry deployment.
export function getIrohRegistryStreamName(): string {
  const fromEnv = process.env.IROH_REGISTRY_STREAM_NAME;
  if (fromEnv) return fromEnv === "_" ? "" : fromEnv;
  try {
    //@ts-ignore
    const fromConfig: string = Config.IROH_REGISTRY_STREAM_NAME;
    return !fromConfig || fromConfig === "_" ? "" : fromConfig;
  } catch {
    return "";
  }
}

/**
 * Builds the JSON value the registry stores and serves for one declaration.
 * If the declaration carries a commonsDbRegistry object (same level as
 * publicMetadata) that object IS the registry value; otherwise a composed
 * fallback is used. Kept as one small function so the mapping can be
 * changed in one place — the registry treats the result as an opaque
 * immutable JSON object.
 *
 * Invariant: the value always carries the declaration's FULL ISCC code
 * string in a top-level `iscc` field. The registry's similarity index
 * (iroh-registry-api documentation/16) extracts the Content-Code from
 * exactly that field; a record without it is stored but unsearchable by
 * similarity.
 */
export function formatIrohRegistryValue(payload: IDeclarationPayload, s3Path: string): object {
  const commonsDbRegistry = payload?.declarationMetadata?.commonsDbRegistry;
  const fullIscc =
    commonsDbRegistry?.iscc || payload?.metaInternal?.isccCode || payload?.declarationMetadata?.publicMetadata?.iscc;
  if (commonsDbRegistry) {
    // Untouched (byte-identical value, stable content hash) when it already
    // carries its iscc; only patched when the field is absent or empty.
    return commonsDbRegistry.iscc ? commonsDbRegistry : { ...commonsDbRegistry, iscc: fullIscc };
  }
  return {
    publicMetadata: payload?.declarationMetadata?.publicMetadata,
    iscc: fullIscc,
    companyId: payload?.metaInternal?.companyId,
    rayId: payload?.metaInternal?.rayId,
    s3Path,
  };
}

export function formatIrohRegistryRecord(
  identifier: string,
  payload: IDeclarationPayload,
  s3Path: string,
): IIrohRegistryRecord {
  return {
    key: identifier,
    value: JSON.stringify(formatIrohRegistryValue(payload, s3Path)),
  };
}

/** One live declaration → one put event. Partition key = record key, so a
 * put and a later redact of the same identifier stay ordered. */
export async function putToIrohRegistry(record: IIrohRegistryRecord): Promise<void> {
  const streamName = getIrohRegistryStreamName();
  if (!streamName) {
    console.log("Iroh registry stream not configured for this stage, skipping put:", record.key);
    return;
  }
  await kinesisClient.send(
    new PutRecordCommand({
      StreamName: streamName,
      PartitionKey: record.key,
      Data: Buffer.from(JSON.stringify({ action: "put", key: record.key, value: record.value, source: EVENT_SOURCE })),
    }),
  );
  console.log("Iroh registry: put event queued for identifier:", record.key);
}

/** Redact (isRedacted=true) or un-redact (false) identifiers in the
 * registry. Mirrors the Redacted-table semantics: redact denylists the
 * record there, un-redact republishes it. */
export async function sendIrohRegistryRedactions(
  identifiers: string[],
  isRedacted: boolean,
  reason?: string,
): Promise<{ success: string[]; failed: string[] }> {
  const events = identifiers.map((identifier) =>
    isRedacted
      ? { action: "redact", key: identifier, reason: reason || "redacted in commonsdb", source: EVENT_SOURCE }
      : { action: "unredact", key: identifier, source: EVENT_SOURCE },
  );
  return sendIrohRegistryEvents(events);
}

/** Batched PutRecords with per-record failure reporting — used by the
 * redaction path and the backfill script. Events must carry a `key`. */
export async function sendIrohRegistryEvents(
  events: Array<{ action: string; key: string } & Record<string, unknown>>,
): Promise<{ success: string[]; failed: string[] }> {
  const success: string[] = [];
  const failed: string[] = [];
  if (events.length === 0) return { success, failed };

  const streamName = getIrohRegistryStreamName();
  if (!streamName) {
    console.log("Iroh registry stream not configured for this stage, skipping", events.length, "events");
    return { success, failed: events.map((e) => e.key) };
  }

  for (let i = 0; i < events.length; i += PUT_RECORDS_BATCH_SIZE) {
    const batch = events.slice(i, i + PUT_RECORDS_BATCH_SIZE);
    try {
      const result = await kinesisClient.send(
        new PutRecordsCommand({
          StreamName: streamName,
          Records: batch.map((event) => ({
            PartitionKey: event.key,
            Data: Buffer.from(JSON.stringify(event)),
          })),
        }),
      );
      // Kinesis reports partial failures per record, not by throwing.
      (result.Records || []).forEach((record, idx) => {
        if (record.ErrorCode) {
          failed.push(batch[idx].key);
        } else {
          success.push(batch[idx].key);
        }
      });
    } catch (error) {
      console.error("Iroh registry: PutRecords batch failed:", (error as Error).message);
      failed.push(...batch.map((e) => e.key));
    }
  }

  console.log("Iroh registry: events sent,", success.length, "success,", failed.length, "failed");
  return { success, failed };
}
