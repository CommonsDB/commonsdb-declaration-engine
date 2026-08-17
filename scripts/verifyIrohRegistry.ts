// Audit that the iroh registry contains exactly what it should: every
// eligible declaration from this project, nothing else, all published.
//
// Two full scans, then a set diff — no per-record lookups on the happy path:
//   A. IdentifiersOfDeclaration → the "eligible" set (same rules as the
//      backfill: optional --min-timestamp cutoff on publicMetadata.timestamp,
//      redacted identifiers excluded).
//   B. The registry's record-index table → per-key status.
// Reported:
//   - missing:    eligible but absent from the registry (written to a file;
//                 feed it back via backfillIrohRegistry --ids-file, or just
//                 re-run the backfill — both are idempotent).
//   - pending:    present but not yet HAMT-published (normal while the
//                 write-api-worker is still draining; re-check later).
//   - denylisted: present but taken down in the registry.
//   - unexpected: in the registry but not eligible — each is classified by
//                 re-reading the source table (redacted upstream / older
//                 than the cutoff / missing from source entirely).
//   - sample:     with --sample N, N random matched records get a full
//                 integrity check: refetch S3 payload, re-run the exact
//                 formatter, BLAKE3 the value string, compare to the
//                 registry's stored content_hash byte-for-byte.
// Exit code 0 only when missing = unexpected = denylisted = sample
// mismatches = 0 AND (pending = 0 or --allow-pending was given).
//
// Live-traffic caveat: the two scans are not one atomic snapshot, so
// declarations created while the audit runs can land in either diff for
// one run ("created_during_scan" is detected and treated as benign;
// the mirror image — a brand-new record counted missing because it was
// ingested after the registry scan passed — clears on the next run, or
// harmlessly no-ops through backfillIrohRegistry --ids-file).
//
// Required env:
//   AWS_REGION              e.g. eu-central-1
//   IDENTIFIERS_TABLE       e.g. cdb-b2b-api-prod-commonsdb-IdentifiersOfDeclaration
//   REGISTRY_INDEX_TABLE    e.g. cdb-b2b-prod-record-index
// Optional env:
//   REDACTED_TABLE          e.g. cdb-b2b-api-prod-commonsdb-Redacted
//   DECLARATION_BUCKET      required only with --sample
// Flags:
//   --min-timestamp <d>   same cutoff the backfill ran with (e.g. 2026-01-09)
//   --segments <n>        parallel scan segments per table (default 4)
//   --sample <n>          random deep content-hash checks (default 0)
//   --allow-pending       don't fail the run on pending records
//   --missing-out <path>  default .iroh-verify-missing.txt
//   --unexpected-out <path> default .iroh-verify-unexpected.txt
//
// Usage:
//   AWS_REGION=eu-central-1 \
//   IDENTIFIERS_TABLE=cdb-b2b-api-prod-commonsdb-IdentifiersOfDeclaration \
//   REDACTED_TABLE=cdb-b2b-api-prod-commonsdb-Redacted \
//   REGISTRY_INDEX_TABLE=cdb-b2b-prod-record-index \
//   DECLARATION_BUCKET=cdb-b2b-api-prod-commonsdb-declaration-data \
//     npx tsx ./scripts/verifyIrohRegistry.ts --min-timestamp 2026-01-09 --sample 500

import * as fs from "fs";
import * as dns from "dns";
import * as https from "https";
import { DynamoDBClient, GetItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { formatIrohRegistryRecord } from "../packages/core/src/searchUtils/irohRegistryUtil";
import { IDeclarationPayload } from "../packages/core/src/interfaces/commonInterfaces";

// Same resolver-storm protection as the backfill script: cache the few
// hostnames involved and serve stale addresses when a refresh fails.
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

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, lookup: cachedLookup });

const dynamo = new DynamoDBClient({ maxAttempts: 10, requestHandler: { httpsAgent } });
const s3 = new S3Client({ maxAttempts: 10, requestHandler: { httpsAgent } });

const RETRY_ATTEMPTS = 6;

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delayMs = 1000 * 2 ** attempt;
      console.error(
        `${label} failed (attempt ${attempt + 1}/${RETRY_ATTEMPTS}), retrying in ${delayMs}ms:`,
        (error as Error).message,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

interface Args {
  minTimestamp: Date | null;
  segments: number;
  sample: number;
  allowPending: boolean;
  missingOut: string;
  unexpectedOut: string;
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
    minTimestamp,
    segments: flag("segments") ? parseInt(flag("segments")!, 10) : 4,
    sample: flag("sample") ? parseInt(flag("sample")!, 10) : 0,
    allowPending: argv.includes("--allow-pending"),
    missingOut: flag("missing-out") || ".iroh-verify-missing.txt",
    unexpectedOut: flag("unexpected-out") || ".iroh-verify-unexpected.txt",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// Same comparison the backfill and the search endpoints use.
function passesMinTimestamp(contentJson: string | undefined, minTimestamp: Date): boolean {
  if (!contentJson) return false;
  try {
    return new Date(JSON.parse(contentJson).timestamp) > minTimestamp;
  } catch {
    return false;
  }
}

async function loadRedactedSet(table: string | undefined): Promise<Set<string>> {
  const redacted = new Set<string>();
  if (!table) {
    console.log("REDACTED_TABLE not set — treating no identifiers as redacted");
    return redacted;
  }
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  do {
    const page: any = await withRetries("Redacted scan", () =>
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
  console.log(`Redacted identifiers: ${redacted.size}`);
  return redacted;
}

interface SampleCandidate {
  identifier: string;
  s3Path: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sourceTable = requireEnv("IDENTIFIERS_TABLE");
  const registryTable = requireEnv("REGISTRY_INDEX_TABLE");
  const bucket = args.sample > 0 ? requireEnv("DECLARATION_BUCKET") : process.env.DECLARATION_BUCKET;

  console.log("Verify starting:", { sourceTable, registryTable, ...args });
  const redacted = await loadRedactedSet(process.env.REDACTED_TABLE);

  // --- Pass A: build the eligible set from the source table ---
  const eligible = new Set<string>();
  let sourceScanned = 0;
  let sourceSkippedOld = 0;
  let sourceSkippedRedacted = 0;
  // Reservoir sample of eligible records for the deep content check.
  const reservoir: SampleCandidate[] = [];
  let reservoirSeen = 0;

  const scanSourceSegment = async (segment: number) => {
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    do {
      const page: any = await withRetries(`source scan segment ${segment}`, () =>
        dynamo.send(
          new ScanCommand({
            TableName: sourceTable,
            Segment: segment,
            TotalSegments: args.segments,
            ProjectionExpression: args.minTimestamp ? "identifier, s3Path, content" : "identifier, s3Path",
            ExclusiveStartKey: lastEvaluatedKey,
          }),
        ),
      );
      for (const item of page.Items || []) {
        const identifier = item.identifier?.S;
        const s3Path = item.s3Path?.S;
        if (!identifier || !s3Path) continue;
        sourceScanned += 1;
        if (redacted.has(identifier)) {
          sourceSkippedRedacted += 1;
          continue;
        }
        if (args.minTimestamp && !passesMinTimestamp(item.content?.S, args.minTimestamp)) {
          sourceSkippedOld += 1;
          continue;
        }
        eligible.add(identifier);
        if (args.sample > 0) {
          reservoirSeen += 1;
          if (reservoir.length < args.sample) {
            reservoir.push({ identifier, s3Path });
          } else {
            const j = Math.floor(Math.random() * reservoirSeen);
            if (j < args.sample) reservoir[j] = { identifier, s3Path };
          }
        }
        if (sourceScanned % 250000 === 0) {
          console.log(`source scan progress: ${sourceScanned} scanned, ${eligible.size} eligible`);
        }
      }
      lastEvaluatedKey = page.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  };
  await Promise.all(Array.from({ length: args.segments }, (_, i) => scanSourceSegment(i)));
  const eligibleTotal = eligible.size;
  console.log(
    `Source: ${sourceScanned} scanned, ${eligibleTotal} eligible, ${sourceSkippedOld} pre-cutoff, ${sourceSkippedRedacted} redacted`,
  );

  // --- Pass B: scan the registry index and diff ---
  let matchedPublished = 0;
  let matchedPending = 0;
  let matchedDenylisted = 0;
  const unexpected: string[] = [];

  const scanRegistrySegment = async (segment: number) => {
    let lastEvaluatedKey: Record<string, any> | undefined = undefined;
    do {
      const page: any = await withRetries(`registry scan segment ${segment}`, () =>
        dynamo.send(
          new ScanCommand({
            TableName: registryTable,
            Segment: segment,
            TotalSegments: args.segments,
            ProjectionExpression: "#k, #s",
            ExpressionAttributeNames: { "#k": "key", "#s": "status" },
            ExclusiveStartKey: lastEvaluatedKey,
          }),
        ),
      );
      for (const item of page.Items || []) {
        const key = item.key?.S;
        if (!key) continue;
        const status = item.status?.S;
        if (eligible.delete(key)) {
          if (status === "published") matchedPublished += 1;
          else if (status === "denylisted") matchedDenylisted += 1;
          else matchedPending += 1;
        } else {
          unexpected.push(key);
        }
      }
      lastEvaluatedKey = page.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  };
  await Promise.all(Array.from({ length: args.segments }, (_, i) => scanRegistrySegment(i)));

  // Whatever survived in `eligible` was never seen in the registry.
  const missing = [...eligible];

  // Classify unexpected keys by re-reading the source table (there should
  // be few of these; per-key lookups are fine here). A key that turns out
  // to be eligible after all was simply written between the two scan
  // passes (live traffic during a long audit) — benign, reported
  // separately and not counted as a failure.
  const unexpectedClassified: Record<string, number> = {
    redacted_upstream: 0,
    pre_cutoff: 0,
    not_in_source: 0,
    created_during_scan: 0,
  };
  const genuinelyUnexpected: string[] = [];
  for (const key of unexpected) {
    if (redacted.has(key)) {
      unexpectedClassified.redacted_upstream += 1;
      genuinelyUnexpected.push(key);
      continue;
    }
    const item: any = await withRetries(`source get ${key}`, () =>
      dynamo.send(
        new GetItemCommand({
          TableName: sourceTable,
          Key: { identifier: { S: key } },
          ProjectionExpression: "identifier, content",
        }),
      ),
    );
    if (!item.Item) {
      unexpectedClassified.not_in_source += 1;
      genuinelyUnexpected.push(key);
    } else if (args.minTimestamp && !passesMinTimestamp(item.Item.content?.S, args.minTimestamp)) {
      unexpectedClassified.pre_cutoff += 1;
      genuinelyUnexpected.push(key);
    } else {
      unexpectedClassified.created_during_scan += 1;
    }
  }

  // --- Optional deep sample: refetch, re-format, re-hash, compare ---
  let sampleChecked = 0;
  let sampleMismatches = 0;
  const sampleTargets = reservoir.filter((c) => !eligible.has(c.identifier)); // matched only
  for (const candidate of sampleTargets) {
    const registryItem: any = await withRetries(`registry get ${candidate.identifier}`, () =>
      dynamo.send(
        new GetItemCommand({
          TableName: registryTable,
          Key: { key: { S: candidate.identifier } },
          ProjectionExpression: "content_hash",
        }),
      ),
    );
    const storedHash = registryItem.Item?.content_hash?.S;
    const object = await withRetries(`S3 get ${candidate.s3Path}`, () =>
      s3.send(
        new GetObjectCommand({
          Bucket: bucket!,
          Key: candidate.s3Path.replace(/^s3:\/\//i, "").replace(`${bucket}/`, ""),
        }),
      ),
    );
    const payload = JSON.parse((await object.Body!.transformToString())!) as IDeclarationPayload;
    const record = formatIrohRegistryRecord(candidate.identifier, payload, candidate.s3Path);
    const computedHash = bytesToHex(blake3(new TextEncoder().encode(record.value)));
    sampleChecked += 1;
    if (storedHash !== computedHash) {
      sampleMismatches += 1;
      console.error(`CONTENT MISMATCH for ${candidate.identifier}: registry=${storedHash} computed=${computedHash}`);
    }
  }

  // --- Report ---
  fs.writeFileSync(args.missingOut, missing.join("\n") + (missing.length ? "\n" : ""));
  fs.writeFileSync(args.unexpectedOut, genuinelyUnexpected.join("\n") + (genuinelyUnexpected.length ? "\n" : ""));

  const summary = {
    eligible: eligibleTotal,
    registry_published: matchedPublished,
    registry_pending: matchedPending,
    registry_denylisted: matchedDenylisted,
    missing_from_registry: missing.length,
    unexpected_in_registry: genuinelyUnexpected.length,
    unexpected_breakdown: unexpectedClassified,
    sample_checked: sampleChecked,
    sample_content_mismatches: sampleMismatches,
  };
  console.log("Verification summary:", JSON.stringify(summary, null, 2));
  if (missing.length) console.log(`Missing identifiers written to ${args.missingOut}`);
  if (genuinelyUnexpected.length) console.log(`Unexpected keys written to ${args.unexpectedOut}`);

  const pendingOk = args.allowPending || matchedPending === 0;
  const ok =
    missing.length === 0 &&
    genuinelyUnexpected.length === 0 &&
    matchedDenylisted === 0 &&
    sampleMismatches === 0 &&
    pendingOk;
  if (ok) {
    console.log(
      `VERIFIED: all ${eligibleTotal} eligible records are in the registry` +
        (matchedPending > 0 ? ` (${matchedPending} still pending publication)` : ", all published"),
    );
    process.exit(0);
  }
  console.error("VERIFICATION FAILED — see summary above");
  if (matchedPending > 0 && !args.allowPending) {
    console.error(
      `note: ${matchedPending} records are pending — if the worker is still draining, re-run later or use --allow-pending`,
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error("Verification aborted:", error);
  process.exit(1);
});
