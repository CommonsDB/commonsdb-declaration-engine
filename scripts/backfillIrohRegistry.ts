// Backfill / reconciliation of existing declarations into the iroh
// registry (iroh-registry-api: documentation/15-external-ingestion.md).
//
// Scans the IdentifiersOfDeclaration table, loads each declaration's stored
// payload from S3, formats it with the SAME formatter the live indexer uses
// (irohRegistryUtil.formatIrohRegistryRecord — byte-identical values are
// what makes the registry-side dedup recognize resubmissions), and puts
// batched "put" events onto the registry's external ingestion stream.
// Identifiers marked redacted=1 in the Redacted table are skipped.
//
// The registry ingestion is idempotent (already-present records resolve to
// duplicate no-ops), so this script is safe to re-run at any time to
// reconcile records the live mirror missed — that re-runnability IS the
// "keep it updated" mechanism, alongside the live mirror in
// indexingUtils.processIsccStringRaw.
//
// Runs OUTSIDE Lambda with plain AWS credentials. Required env:
//   AWS_REGION                  e.g. eu-central-1 (plus credentials/profile)
//   IROH_REGISTRY_STREAM_NAME   e.g. cdb-b2b-prod-registry-external-ingestion
//   IDENTIFIERS_TABLE           deployed IdentifiersOfDeclaration table name
//   DECLARATION_BUCKET          e.g. prod-commonsdb-declaration-data
//   REDACTED_TABLE              (optional) deployed Redacted table name
// Flags:
//   --dry-run           scan + format but do not put to Kinesis
//   --limit <n>         stop after n records total (smoke testing)
//   --segments <n>      parallel scan segments (default 4)
//   --concurrency <n>   parallel S3 reads per segment page (default 25)
//   --state-file <path> resume checkpoint (default .backfill-iroh-state.json)
//   --min-timestamp <d> only records whose publicMetadata.timestamp is after
//                       this date (e.g. 2026-01-09) — same comparison the
//                       search APIs apply with MIN_DECLARATION_TIMESTAMP.
//                       Checked against the item's own content attribute, so
//                       excluded records cost no S3 read.
//   --ids-file <path>   repair mode: instead of scanning the table, process
//                       exactly the identifiers listed in the file (one per
//                       line — e.g. verifyIrohRegistry's missing output).
//                       Filters (redacted, --min-timestamp) still apply.
//
// Usage:
//   IROH_REGISTRY_STREAM_NAME=... IDENTIFIERS_TABLE=... DECLARATION_BUCKET=... \
//     npx tsx ./scripts/backfillIrohRegistry.ts --dry-run --limit 100
// (or: pnpm backfill:iroh-registry -- --dry-run --limit 100)

import * as fs from "fs";
import * as dns from "dns";
import * as https from "https";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import {
  formatIrohRegistryRecord,
  sendIrohRegistryEvents,
  setIrohRegistryKinesisClient,
  IIrohRegistryRecord,
} from "../packages/core/src/searchUtils/irohRegistryUtil";
import { IDeclarationPayload } from "../packages/core/src/interfaces/commonInterfaces";

// A long run at ~100 concurrent S3 requests can storm the macOS system
// resolver into persistent getaddrinfo ENOTFOUND (observed twice, ~10 min
// in, while `nslookup` from another process was fine). Only a handful of
// hostnames are ever resolved here, so cache lookups for 5 minutes and —
// crucially — serve the last known address when a refresh fails.
const dnsCache = new Map<string, { entries: dns.LookupAddress[]; expires: number }>();
const DNS_TTL_MS = 5 * 60 * 1000;

const cachedLookup = ((hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const respond = (entries: dns.LookupAddress[]) => {
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  };
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return respond(cached.entries);
  dns.lookup(hostname, { ...options, all: true }, (err, entries) => {
    if (!err && Array.isArray(entries) && entries.length > 0) {
      dnsCache.set(hostname, { entries, expires: Date.now() + DNS_TTL_MS });
      return respond(entries);
    }
    if (cached) {
      console.error(`DNS refresh for ${hostname} failed (${err?.code}); using cached address`);
      return respond(cached.entries);
    }
    callback(err ?? new Error(`lookup ${hostname} returned no addresses`));
  });
}) as typeof dns.lookup;

// Socket pool sized for high-latency conditions: with ~1s round-trips on a
// loaded machine, throughput ≈ pool size / latency, so a small pool caps
// the whole run regardless of --concurrency.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, lookup: cachedLookup });

// Generous SDK retries plus the withRetries wrapper below: a multi-hour run
// over millions of records WILL hit transient DNS/socket/throttling errors,
// and none of them should kill the process (a real outage still aborts
// after the wrapper gives up — resume via the state file).
const dynamo = new DynamoDBClient({ maxAttempts: 10, requestHandler: { httpsAgent } });
const s3 = new S3Client({ maxAttempts: 10, requestHandler: { httpsAgent } });
setIrohRegistryKinesisClient(new KinesisClient({ maxAttempts: 10, requestHandler: { httpsAgent } }));

const RETRY_ATTEMPTS = 8;
const RETRY_MAX_DELAY_MS = 60_000;

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt + 1 === RETRY_ATTEMPTS) break;
      const delayMs = Math.min(1000 * 2 ** attempt, RETRY_MAX_DELAY_MS);
      console.error(
        `${label} failed (attempt ${attempt + 1}/${RETRY_ATTEMPTS}), retrying in ${delayMs}ms:`,
        (error as Error).message,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// PutRecords caps at 500 records / 5 MB; flush earlier on payload size.
const KINESIS_FLUSH_COUNT = 500;
const KINESIS_FLUSH_BYTES = 4 * 1024 * 1024;
const SCAN_PAGE_SIZE = 500;

interface Args {
  dryRun: boolean;
  limit: number | null;
  segments: number;
  concurrency: number;
  stateFile: string;
  minTimestamp: Date | null;
  idsFile: string | null;
}

interface SegmentState {
  // DynamoDB LastEvaluatedKey of the last fully processed page, or "done".
  lastEvaluatedKey?: Record<string, unknown> | "done";
}

interface BackfillState {
  segments: Record<string, SegmentState>;
  stats: Stats;
}

interface Stats {
  scanned: number;
  sent: number;
  skippedRedacted: number;
  skippedOld: number;
  missingS3: number;
  failed: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const minTimestampRaw = flag("min-timestamp");
  const minTimestamp = minTimestampRaw ? new Date(minTimestampRaw) : null;
  if (minTimestamp && isNaN(minTimestamp.getTime())) {
    console.error(`--min-timestamp is not a parseable date: ${minTimestampRaw}`);
    process.exit(1);
  }
  return {
    dryRun: argv.includes("--dry-run"),
    limit: flag("limit") ? parseInt(flag("limit")!, 10) : null,
    segments: flag("segments") ? parseInt(flag("segments")!, 10) : 4,
    concurrency: flag("concurrency") ? parseInt(flag("concurrency")!, 10) : 25,
    stateFile: flag("state-file") || ".backfill-iroh-state.json",
    minTimestamp,
    idsFile: flag("ids-file"),
  };
}

// Same comparison the search endpoints apply with MIN_DECLARATION_TIMESTAMP:
// new Date(publicMetadata.timestamp) must be strictly after the cutoff. A
// missing or unparseable timestamp compares false there too, so it is
// excluded here as well.
function passesMinTimestamp(contentJson: string | undefined, minTimestamp: Date): boolean {
  if (!contentJson) return false;
  try {
    const publicMetadata = JSON.parse(contentJson);
    return new Date(publicMetadata.timestamp) > minTimestamp;
  } catch {
    return false;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function loadState(path: string, segments: number): BackfillState {
  if (fs.existsSync(path)) {
    const state: BackfillState = JSON.parse(fs.readFileSync(path, "utf-8"));
    if (Object.keys(state.segments).length !== segments) {
      console.error(
        `State file ${path} was written with ${Object.keys(state.segments).length} segments, ` +
          `but --segments is ${segments}. Use the same segment count or delete the state file.`,
      );
      process.exit(1);
    }
    console.log("Resuming from state file:", path, JSON.stringify(state.stats));
    return state;
  }
  const fresh: BackfillState = {
    segments: {},
    stats: { scanned: 0, sent: 0, skippedRedacted: 0, skippedOld: 0, missingS3: 0, failed: 0 },
  };
  for (let i = 0; i < segments; i++) fresh.segments[String(i)] = {};
  return fresh;
}

function saveState(path: string, state: BackfillState): void {
  fs.writeFileSync(path, JSON.stringify(state));
}

// The Redacted table is small relative to the main table; one full scan up
// front beats 4M per-item lookups.
async function loadRedactedSet(table: string | undefined): Promise<Set<string>> {
  const redacted = new Set<string>();
  if (!table) {
    console.log("REDACTED_TABLE not set — not skipping redacted identifiers");
    return redacted;
  }
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  do {
    const page: any = await withRetries("Redacted table scan", () =>
      dynamo.send(
        new ScanCommand({
          TableName: table,
          FilterExpression: "redacted = :one",
          ExpressionAttributeValues: { ":one": { N: "1" } },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      ),
    );
    for (const item of page.Items || []) {
      if (item.identifier?.S) redacted.add(item.identifier.S);
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  console.log(`Loaded ${redacted.size} redacted identifiers to skip`);
  return redacted;
}

function cleanS3Key(s3Path: string, bucket: string): string {
  return s3Path.replace(/^s3:\/\//i, "").replace(`${bucket}/`, "");
}

async function fetchPayload(bucket: string, s3Path: string): Promise<IDeclarationPayload | null> {
  return withRetries(`S3 get ${s3Path}`, async () => {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cleanS3Key(s3Path, bucket) }));
      const body = await object.Body?.transformToString();
      return body ? (JSON.parse(body) as IDeclarationPayload) : null;
    } catch (error: any) {
      // A genuinely absent object is a data condition, not a fault — do not
      // burn retry attempts on it.
      if (error.name === "NoSuchKey") return null;
      throw error;
    }
  });
}

interface PendingEvent {
  action: string;
  key: string;
  value: string;
  source: string;
  byteSize: number;
}

async function flush(pending: PendingEvent[], args: Args, stats: Stats): Promise<void> {
  if (pending.length === 0) return;
  if (args.dryRun) {
    stats.sent += pending.length;
    pending.length = 0;
    return;
  }
  // Kinesis PutRecords partial failures (throttles, transient 5xx) get their
  // own retry loop over just the failed records; only what survives all
  // attempts is counted as failed.
  let events = pending.map(({ byteSize, ...event }) => event);
  for (let attempt = 0; events.length > 0 && attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delayMs = 1000 * 2 ** attempt;
      console.error(
        `Retrying ${events.length} unsent events in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const { success, failed } = await sendIrohRegistryEvents(events);
    stats.sent += success.length;
    const failedSet = new Set(failed);
    events = events.filter((event) => failedSet.has(event.key));
  }
  if (events.length > 0) {
    stats.failed += events.length;
    console.error(
      `Giving up on ${events.length} events, first few:`,
      events.slice(0, 5).map((e) => e.key),
    );
  }
  pending.length = 0;
}

async function processSegment(
  segment: number,
  args: Args,
  state: BackfillState,
  redacted: Set<string>,
  table: string,
  bucket: string,
  limitReached: () => boolean,
): Promise<void> {
  const segmentState = state.segments[String(segment)];
  if (segmentState.lastEvaluatedKey === "done") return;

  const pending: PendingEvent[] = [];
  let pendingBytes = 0;
  let lastEvaluatedKey = segmentState.lastEvaluatedKey as Record<string, any> | undefined;

  do {
    if (limitReached()) break;
    // `content` (the item's own publicMetadata copy) is only pulled when a
    // timestamp cutoff is active — it carries the bulk of the item size, but
    // filtering on it here saves an S3 GET per excluded record.
    const page: any = await withRetries(`segment ${segment} scan`, () =>
      dynamo.send(
        new ScanCommand({
          TableName: table,
          Segment: segment,
          TotalSegments: args.segments,
          Limit: SCAN_PAGE_SIZE,
          ProjectionExpression: args.minTimestamp ? "identifier, s3Path, content" : "identifier, s3Path",
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      ),
    );

    const items = (page.Items || [])
      .map((item: any) => ({
        identifier: item.identifier?.S,
        s3Path: item.s3Path?.S,
        content: item.content?.S,
      }))
      .filter((item: any) => item.identifier && item.s3Path);

    // Worker pool rather than chunked Promise.all: a chunk waits for its
    // slowest member, so latency outliers (loaded machine, S3 tail
    // latency) would cap throughput at chunk-size / worst-latency. With a
    // pool, each worker moves on independently and throughput tracks the
    // average latency instead.
    {
      type ItemResult =
        | { kind: "redacted" }
        | { kind: "old" }
        | { kind: "missing"; item: { identifier: string; s3Path: string } }
        | { kind: "record"; record: IIrohRegistryRecord };
      const results: ItemResult[] = new Array(items.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(args.concurrency, items.length) }, async () => {
          while (true) {
            const i = cursor++;
            if (i >= items.length) break;
            const item = items[i] as { identifier: string; s3Path: string; content?: string };
            if (redacted.has(item.identifier)) {
              results[i] = { kind: "redacted" };
            } else if (args.minTimestamp && !passesMinTimestamp(item.content, args.minTimestamp)) {
              results[i] = { kind: "old" };
            } else {
              const payload = await fetchPayload(bucket, item.s3Path);
              results[i] = payload
                ? { kind: "record", record: formatIrohRegistryRecord(item.identifier, payload, item.s3Path) }
                : { kind: "missing", item };
            }
          }
        }),
      );
      for (const result of results) {
        state.stats.scanned += 1;
        if (result.kind === "redacted") {
          state.stats.skippedRedacted += 1;
        } else if (result.kind === "old") {
          state.stats.skippedOld += 1;
        } else if (result.kind === "missing") {
          state.stats.missingS3 += 1;
          console.error("No S3 object for identifier:", result.item.identifier, result.item.s3Path);
        } else {
          const byteSize = result.record.value.length + result.record.key.length + 64;
          pending.push({
            action: "put",
            key: result.record.key,
            value: result.record.value,
            source: "commonsdb-serverless/backfill",
            byteSize,
          });
          pendingBytes += byteSize;
          if (pending.length >= KINESIS_FLUSH_COUNT || pendingBytes >= KINESIS_FLUSH_BYTES) {
            await flush(pending, args, state.stats);
            pendingBytes = 0;
          }
        }
      }
    }

    // Flush before checkpointing the page: the state file must never claim
    // a page whose events were not handed to Kinesis yet. (A crash between
    // flush and save just re-sends a page — idempotent on the registry side.)
    await flush(pending, args, state.stats);
    pendingBytes = 0;
    lastEvaluatedKey = page.LastEvaluatedKey;
    segmentState.lastEvaluatedKey = lastEvaluatedKey ?? "done";
    saveState(args.stateFile, state);
    console.log(
      `[segment ${segment}] page done | total:`,
      JSON.stringify(state.stats),
      lastEvaluatedKey ? "" : "(segment complete)",
    );
  } while (lastEvaluatedKey);
}

// Repair mode: fetch exactly the listed identifiers (BatchGetItem, 100 per
// call), apply the same filters, and send them. No scan, no state file.
async function processIdsFile(args: Args, redacted: Set<string>, table: string, bucket: string): Promise<Stats> {
  const stats: Stats = { scanned: 0, sent: 0, skippedRedacted: 0, skippedOld: 0, missingS3: 0, failed: 0 };
  const ids = fs
    .readFileSync(args.idsFile!, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  console.log(`Repair mode: ${ids.length} identifiers from ${args.idsFile}`);

  const pending: PendingEvent[] = [];
  const { BatchGetItemCommand } = await import("@aws-sdk/client-dynamodb");
  for (let i = 0; i < ids.length; i += 100) {
    const batch = [...new Set(ids.slice(i, i + 100))];
    const response: any = await withRetries("BatchGetItem", () =>
      dynamo.send(
        new BatchGetItemCommand({
          RequestItems: {
            [table]: {
              Keys: batch.map((id) => ({ identifier: { S: id } })),
              ProjectionExpression: "identifier, s3Path, content",
            },
          },
        }),
      ),
    );
    const items = (response.Responses?.[table] ?? [])
      .map((item: any) => ({
        identifier: item.identifier?.S,
        s3Path: item.s3Path?.S,
        content: item.content?.S,
      }))
      .filter((item: any) => item.identifier && item.s3Path);
    const foundIds = new Set(items.map((i: any) => i.identifier));
    for (const id of batch) {
      if (!foundIds.has(id)) {
        stats.scanned += 1;
        stats.missingS3 += 1;
        console.error("Identifier not found in source table:", id);
      }
    }
    for (const item of items) {
      stats.scanned += 1;
      if (redacted.has(item.identifier)) {
        stats.skippedRedacted += 1;
        continue;
      }
      if (args.minTimestamp && !passesMinTimestamp(item.content, args.minTimestamp)) {
        stats.skippedOld += 1;
        continue;
      }
      const payload = await fetchPayload(bucket, item.s3Path);
      if (!payload) {
        stats.missingS3 += 1;
        console.error("No S3 object for identifier:", item.identifier, item.s3Path);
        continue;
      }
      const record = formatIrohRegistryRecord(item.identifier, payload, item.s3Path);
      pending.push({
        action: "put",
        key: record.key,
        value: record.value,
        source: "commonsdb-serverless/backfill",
        byteSize: record.value.length + record.key.length + 64,
      });
      if (pending.length >= KINESIS_FLUSH_COUNT) await flush(pending, args, stats);
    }
  }
  await flush(pending, args, stats);
  return stats;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const table = requireEnv("IDENTIFIERS_TABLE");
  const bucket = requireEnv("DECLARATION_BUCKET");
  if (!args.dryRun) requireEnv("IROH_REGISTRY_STREAM_NAME");

  if (args.idsFile) {
    const redacted = await loadRedactedSet(process.env.REDACTED_TABLE);
    const stats = await processIdsFile(args, redacted, table, bucket);
    console.log("Repair finished:", JSON.stringify(stats, null, 2));
    return;
  }

  console.log("Backfill starting:", {
    table,
    bucket,
    stream: process.env.IROH_REGISTRY_STREAM_NAME,
    ...args,
  });

  const state = loadState(args.stateFile, args.segments);
  const redacted = await loadRedactedSet(process.env.REDACTED_TABLE);

  const limitReached = () => args.limit !== null && state.stats.scanned >= args.limit;

  await Promise.all(
    Array.from({ length: args.segments }, (_, segment) =>
      processSegment(segment, args, state, redacted, table, bucket, limitReached),
    ),
  );

  console.log("Backfill finished:", JSON.stringify(state.stats, null, 2));
  const done = Object.values(state.segments).every((s) => s.lastEvaluatedKey === "done");
  if (done && !args.limit) {
    console.log(`All segments complete. Delete ${args.stateFile} before a fresh reconciliation run.`);
  }
}

main().catch((error) => {
  console.error("Backfill aborted:", error);
  process.exit(1);
});
