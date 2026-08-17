import { Client } from "pg";
import { createHash } from "crypto";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { Config } from "sst/node/config";

/**
 * Live sync of a single ingested declaration into the `cdb_stats` Postgres
 * database (and the `cdb_processed_declarations` DynamoDB de-dup table) that the
 * commons-db-statistics pipeline owns.
 *
 * This mirrors the field extraction / hashing the batch pipeline performs so a
 * record written here is byte-for-byte interchangeable with one the full S3
 * backfill would produce:
 *   - declarations.record_hash = SHA-256(source_key + raw JSON body)
 *   - cdb_processed_declarations.etag = MD5(raw JSON body)  (S3 ETag for a
 *     non-multipart PUT, matching the value the pipeline reads from ListObjects)
 *
 * Writes are idempotent (`ON CONFLICT DO NOTHING` on declarations, plain Put on
 * the de-dup table) so this is safe to retry and safe to run alongside the batch
 * pipeline. Marking the file processed in DynamoDB means the batch pipeline will
 * skip it; if this live sync ever fails (caller treats it as best-effort), the
 * file stays unmarked and the next batch run reconciles it.
 */

// ── Connection handling ───────────────────────────────────────────────────────
//
// This runs inside the high-concurrency Kinesis consumer. A module-level pg.Pool
// is the classic Lambda connection leak: a frozen container keeps its TCP
// connections open server-side (the idle timer never fires while frozen), so
// every warm container permanently holds RDS slots and quickly exhausts the
// instance (Postgres 53300). We instead open a short-lived Client per call and
// always close it, bounding concurrent connections to the number of in-flight
// invocations rather than the number of warm containers.

let dynamo: DynamoDBClient | undefined;

function getDynamo(): DynamoDBClient {
  if (!dynamo) dynamo = new DynamoDBClient({});
  return dynamo;
}

// declarer DID -> numeric id, cached across warm invocations to skip the upsert.
const declarerIdCache = new Map<string, number>();

// ── Helpers (mirror commons-db-statistics aggregator) ─────────────────────────

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/** Extract a YYYY-MM-DD date from a Unix-ms number or ISO/plain date string. */
function resolveDate(value: unknown): string | null {
  if (typeof value === "number" && value > 0) {
    return new Date(value).toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const m = DATE_RE.exec(value.trim());
    return m ? m[1] : null;
  }
  return null;
}

function resolveString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** First non-empty string among the candidates, or null. */
function resolveStringFirst(values: unknown[]): string | null {
  for (const value of values) {
    const resolved = resolveString(value);
    if (resolved !== null) return resolved;
  }
  return null;
}

/** Strip the `s3://bucket/` prefix to obtain the raw S3 object key. */
function s3KeyFromPath(s3Path: string): string {
  return s3Path.replace(/^s3:\/\/[^/]+\//i, "");
}

/**
 * Parse the S3 key into its semantic parts: {did:key}/{iscc}/{cidV1}.json
 * Returns null if the structure does not match (caller skips the sync).
 */
function parseS3Key(key: string): { declarerDid: string; iscc: string; cid: string } | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;

  const declarerDid = parts[0];
  const iscc = parts[1];
  const cid = parts[parts.length - 1].replace(/\.json$/i, "");

  if (!declarerDid.startsWith("did:") || !iscc || !cid) return null;
  return { declarerDid, iscc, cid };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SyncDeclarationToStatsParams {
  /** Postgres connection string for the cdb_stats DB (SECRET_CDB_STATS_PG_URL). */
  connectionString: string;
  /** DynamoDB de-dup table name (cdb_processed_declarations). */
  dynamoTable: string;
  /** Full S3 path returned by saveJsonToS3, e.g. `s3://bucket/{did}/{iscc}/{cid}.json`. */
  s3Path: string;
  /** The exact object that was persisted to S3 (used for hashing). */
  payload: unknown;
}

/**
 * Record a single declaration in the cdb_stats Postgres DB and mark the S3 file
 * as processed in DynamoDB. Idempotent; throws on failure so the caller can
 * decide how to react (the ingest pipeline treats it as best-effort).
 */
export async function syncDeclarationToStats(params: SyncDeclarationToStatsParams): Promise<void> {
  const { connectionString, dynamoTable, s3Path, payload } = params;

  const sourceKey = s3KeyFromPath(s3Path);
  const keyParts = parseS3Key(sourceKey);
  if (!keyParts) {
    console.warn("statsSync: cannot parse S3 key, skipping:", sourceKey);
    return;
  }

  const publicMetadata = (payload as any)?.declarationMetadata?.publicMetadata ?? {};
  // Providers are inconsistent about where supplier fields live: some send
  // `supplierMetadata`, others `supplierData`. Check both (same fallback order
  // as the commons-db-statistics batch pipeline) so neither shape loses its
  // rights statement.
  const supplierSources = [publicMetadata?.supplierMetadata, publicMetadata?.supplierData];

  const date = resolveDate(publicMetadata?.timestamp);
  if (!date) {
    console.warn("statsSync: missing/invalid timestamp, skipping:", sourceKey);
    return;
  }

  const rightsStatement = resolveStringFirst(supplierSources.map((s) => s?.rightsStatement));
  const pdRationale = resolveStringFirst(supplierSources.map((s) => s?.pdRationale));

  const body = JSON.stringify(payload);
  const recordHash = createHash("sha256")
    .update(sourceKey + body)
    .digest("hex");
  // S3 ETag for a simple (non-multipart) PUT is the hex MD5 of the object body.
  const etag = createHash("md5").update(body).digest("hex");

  const db = new Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
    application_name: `stats-ingest-${Config.STAGE}`,
    // RDS uses an AWS-managed cert chain; we do not pin it here.
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  try {
    // 1) Resolve declarer numeric id (upsert once, then cache for warm invocations).
    let declarerId = declarerIdCache.get(keyParts.declarerDid);
    if (declarerId === undefined) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO declarers (did)
         VALUES ($1)
         ON CONFLICT (did) DO UPDATE SET did = EXCLUDED.did
         RETURNING id`,
        [keyParts.declarerDid],
      );
      declarerId = Number(res.rows[0].id);
      declarerIdCache.set(keyParts.declarerDid, declarerId);
    }

    // 2) Insert the declaration row. Idempotent on record_hash / cid unique keys.
    await db.query(
      `INSERT INTO declarations
         (source_key, record_hash, declarer_id, iscc, cid, date, rights_statement, pd_rationale)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
       ON CONFLICT DO NOTHING`,
      [sourceKey, recordHash, declarerId, keyParts.iscc, keyParts.cid, date, rightsStatement, pdRationale],
    );
  } finally {
    await db.end().catch(() => undefined);
  }

  // 3) Mark the S3 file processed so the batch backfill pipeline skips it.
  await getDynamo().send(
    new PutItemCommand({
      TableName: dynamoTable,
      Item: {
        source_key: { S: sourceKey },
        etag: { S: etag },
        record_count: { N: "1" },
        processed_at: { S: new Date().toISOString() },
        folder: { S: `${keyParts.declarerDid}/` },
      },
    }),
  );
}
