# Architecture

This document describes every moving part of the CommonsDB registry backend: the AWS resources,
the data model, and the three main flows (ingest, search, redaction).

## 1. Deployment units

The project is an [SST v2](https://v2.sst.dev) app with two CloudFormation stacks, deployed per
*stage* (SST's environment concept — see [setup.md](setup.md#stages)):

| Stack | File | Contents |
|---|---|---|
| `API` | `stacks/CommonsDBStack.ts` | Everything: 3 HTTP APIs, all Lambdas, 11 DynamoDB tables, S3 bucket, Kinesis stream, EventBridge bus, 3 crons |
| `IsccStack` | `stacks/ISCCStack.ts` | ECS Fargate service running the [`iscc-web`](https://github.com/iscc/iscc-web) container behind an ALB (ISCC code generation) |

A third deployment unit lives **outside this repository**: the **search service**. It owns the
similarity index (and everything below the ISCC level) and is called over HTTPS. The contract the
registry codes against is in [search-service-contract.md](search-service-contract.md). This
registry integrates with it two ways: **indexing** via its Kinesis index stream
(`SEARCH_INDEX_STREAM_NAME`, physical name `<stage>-commonsdb-serverless-search`,
fire-and-forget) and **queries** via its HTTPS API (`SEARCH_SERVICE_URL` + shared key
`SECRET_SEARCH_SERVICE_API_KEY`).

Two more external dependencies are referenced but not provisioned here:

- **`cdb_stats` PostgreSQL database** — statistics store, written live by the ingest pipeline and
  by an external batch pipeline (the `commons-db-statistics` project). Reached via
  `SECRET_CDB_STATS_PG_URL`. The de-dup marker table `cdb_processed_declarations` (DynamoDB) also
  belongs to that project; this stack only grants itself `dynamodb:PutItem` on it.
- **iroh-registry ingestion stream** — an external Kinesis stream (`IROH_REGISTRY_STREAM_NAME`)
  into which declarations and redactions are mirrored (best-effort). Set to `"_"` to disable.

## 2. HTTP APIs

Three separate API Gateway v2 HTTP APIs (separate base URLs, printed as stack outputs):

| Output name | Purpose | Routes |
|---|---|---|
| `API_ingestApi` | Declaration submission | `POST /api/v1/ingest`, `POST /api/v1/direct-ingest`, `GET /api/v1/direct-status` |
| `API_searchApi` | Search, lookup, redaction, status, statistics, analytics | ~18 routes, see [api.md](api.md) |
| `API_customerKeysApi` | Customer signing-key management | `POST /generateKey`, `GET /getDecryptedKey` |

In the production topology an API-gateway layer (Zuplo) sits in front of these URLs, performs
customer-facing API-key validation, and forwards requests with an internal `x-api-key` header plus
identity headers (`x-declarer-id`, `x-company-id`). The Lambdas re-check `x-api-key` against SST
secrets, so the raw AWS URLs are unusable without the internal keys. The `direct-ingest` /
`direct-status` routes bypass the gateway entirely and authenticate against per-declarer API-key
hashes stored in DynamoDB.

## 3. Data model

### 3.1 S3

One versioned bucket per stage — logical name `declarationData`, physical name
`<stage>-commonsdb-declaration-data`. It stores the **full raw declaration JSON** — the source of truth. Objects are
keyed by company and ISCC code; every other store holds pointers into this bucket.

### 3.2 DynamoDB tables

All tables are on-demand (PAY_PER_REQUEST), accessed via AWS SDK v3, names resolved through SST
bindings (`Table.<name>.tableName` — never hardcoded).

| Logical name | Key | Purpose |
|---|---|---|
| `vectorToDataMap` | `ItemID` (search-service item id); GSI `timestampIndex` on `type`+`timestamp` | Maps a search-service item id → S3 path of the declaration. The bridge between similarity search results and declaration data. The GSI (constant `type` attribute) supports "latest declarations" queries. |
| `IdentifiersOfDeclaration` | `identifier` | Primary lookup index: declaration identifier (dynamic field, see §3.3) → public metadata + S3 path |
| `CIDs` | `cid` | Legacy CID → metadata/S3 mapping (superseded by `IdentifiersOfDeclaration`) |
| `DeclarationStatus` | `identifier` | Ingest progress: `pending` → `success` \| `failed`, with message + timestamps |
| `SupersededDeclarations` | `identifier` | Declaration → identifier of the declaration that superseded it |
| `Redacted` | `identifier` | Redaction flags per declaration identifier |
| `RedactedProducts` | `productId` | Redaction flags per product (`entryUUID`) |
| `directIngestRegistrations` | `declarerId` | Per-declarer API-key registrations (SHA-256 hash) for the gateway-free ingest path |
| `customerKeys` | `customerId` | Encrypted customer signing keys (symmetric encryption via `SECRET_ENCRYPTION_KEY`) |
| `AnalyticsCounters` | `counterKey` | Real-time analytics counters (see [analytics-system.md](analytics-system.md)) |
| `SlackRateLimit` | `key` (TTL: `expireAt`) | Global rate-limit state for Slack notifications across parallel Lambda containers |

### 3.3 The dynamic identifier field

The name of the identifier attribute used across tables and query parameters is **not hardcoded**
— it is configured by the secret `SECRET_IDENTIFIER_FIELD_KEY_NAME` and resolved through
`packages/core/src/utils/fieldMapping.ts` (allowed values: `cidV1`, `cidV2`). Endpoints that
accept "the identifier" (`getByDecId`, `getByIdentifier`, `getDeclarationStatus`, ingest
supersedes handling) all read/write whatever field this secret names. In practice it is `cidV1` —
a CIDv1 derived from the declaration.

### 3.4 Similarity index (external)

The similarity index itself lives in the external search service: one indexed item per
declaration, keyed by an opaque, stable item id. That item id is what `vectorToDataMap` maps
back to data. How the service indexes and compares content is its own concern — see
[search-service-contract.md](search-service-contract.md) for the contract.

## 4. Ingest pipeline (critical path)

```
Client ── POST /api/v1/ingest ──► ingest λ
  1. x-api-key check (SECRET_ZUPLO_ACCESS_KEY)
  2. JSON Schema validation (custom validateAgainstJsonSchema; v0.2.0 LOCAL_SCHEMA embedded
     in ingest.ts as fetch fallback)
     • $schema / @context URLs must match the allow-list:
       https://w3id.org/commonsdb/schema/<v>.json
  3. Signature verification — `signature` is an ES256 JWT with embedded JWK;
     payload must match publicMetadata content
  4. TSA verification — `tsaSignature` {tsr, tsq} parsed per RFC 3161; content-only check
  5. Timestamp gate — declaration timestamp (Unix ms) must be within 60 s of server time
     (isTimestampWithin60Seconds)
  6. DeclarationStatus := pending
  7. Kinesis putRecord → declarationStream

declarationStream ──► declarationProcessor λ (consumer "consumerIndexer")
  1. Mint itemId (UUID) + emit index event               → search index Kinesis stream
       { itemId, iscc, rayId }                             (consumed async by the search service)
  2. Save raw declaration JSON to S3                      → s3://…/<company>/<iscc>/…json
  3. Write itemId → S3-path mapping                       → vectorToDataMap
  4. Write identifier → metadata mapping                  → IdentifiersOfDeclaration
  5. Handle `supersedes` field                            → SupersededDeclarations
  6. Best-effort side effects (failures logged, never fail the record):
       • analytics counters        → AnalyticsCounters
       • iroh-registry mirroring   → external Kinesis stream
       • cdb_stats live sync       → Postgres + cdb_processed_declarations marker
  7. DeclarationStatus := success   (on any hard error: failed + Slack alert)

Searchability is eventually consistent: "success" means the declaration is stored and its index
event is on the stream; it becomes findable once the search service consumes the event
(normally seconds).
```

**Failure semantics.** The Kinesis event source uses *partial batch failure*
(`reportBatchItemFailures`), `bisectBatchOnError`, `parallelizationFactor: 10`, batch size 10,
3 retries, starting position LATEST. Every hard error inside the consumer **must propagate** —
exceptions are the retry mechanism. There is **no dead-letter queue**: records that exhaust
retries are dropped, and the Slack error notification is the only signal (see
[operations.md](operations.md)).

**Direct ingest.** `POST /api/v1/direct-ingest` is a gateway-free path: the handler looks up the
declarer in `directIngestRegistrations`, compares the SHA-256 hash of the presented `x-api-key`,
verifies the declarer's JWK, then forwards to the same ingest logic with the internal headers set
server-side. `GET /api/v1/direct-status` is the matching status-poll endpoint.

## 5. Search flow

```
GET /api/v1/search?iscc=ISCC:…
  1. auth (x-api-key)
  2. Similarity search by ISCC                  ← search service (HTTP)
       returns { hashBits, results: [{ itemId, score }, …] }   (up to 100 nearest)
  3. Filter score < 4
  4. itemId → S3 path                           ← vectorToDataMap (batch get)
  5. Fetch full declarations                    ← S3 (batch)
  6. Filter: MIN_DECLARATION_TIMESTAMP, Redacted, RedactedProducts, DECLARER_ID_DENYLIST
  7. Censor: strip private metadata, keep publicMetadata + minimal metaInternal
  8. Sort by score ascending, return
```

`search-iscc` and `searchDeclarer` run the same flow with a wider relevance cutoff (score < 16):
`search-iscc` uses the B2B key (`SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B`) with a slightly different
response shape, and `searchDeclarer` (primary key, `iscc` param only) applies the global
`DECLARER_ID_DENYLIST` — it does **not** filter by a specific declarer. Exact-lookup endpoints (`getByDecId`, `getByIdentifier`, `getByCid`, `getFullById`) skip the
search service entirely and read DynamoDB/S3 directly.

Two modules talk to the search service: `searchServiceClient.ts` (HTTPS queries) and
`searchIndexProducer.ts` (Kinesis index events) — the **only**
modules in the codebase that touch it. Handlers and the indexing pipeline call
their functions (`searchSimilarIscc`, `sendToSearchIndexStream`) and are unaware of the
transport.

## 6. Redaction

`POST /api/v1/redact` sets/clears redaction flags for identifiers (single or bulk) and/or product
ids. Flags are checked at search/read time (declarations are never deleted; S3 stays intact).
Identifier-scoped redactions are additionally mirrored to the iroh-registry stream (best-effort).

## 7. Scheduled jobs and events

| Cron | Schedule | Job |
|---|---|---|
| `AnalyticsRecalculation` | every 48 h | Full recount of analytics counters from S3 (also triggerable via EventBridge event `commonsdb.analytics` / *Analytics Recalculation Request*, or `POST /api/v1/recalculateAnalytics`) |
| `StalePendingCleanup` | every 15 min | Marks `DeclarationStatus` records stuck in `pending` > 1 h as `failed` (also `POST /api/v1/cleanupStalePending`) |
| `RefreshStatsViews` | every 12 h | Drift-correction rebuild of the incremental stats tables in the `cdb_stats` Postgres DB (a declarations trigger keeps them current per-ingest; this is a safety net) |

An EventBridge bus (`bus`, retries: 10) carries the analytics trigger; it is bound to most
functions for future event-driven use.

## 8. Notifications

`packages/core/src/searchUtils/notifyUtil.ts` posts formatted messages to a Slack incoming
webhook (`SECRET_SLACK_WEBHOOK_URL`). Behavior:

- skipped entirely on the `dev` stage;
- success/info/warning/error styling;
- per-company rate limiting backed by the `SlackRateLimit` table (in-memory fast path, DynamoDB
  global window), so parallel Kinesis containers cannot flood the channel;
- `shouldNotifySlack(companyId)` gates success notifications.

**Slack is currently the only alerting channel** — see [operations.md](operations.md).

## 9. ISCC resolution

In this registry, `ISCC_HOST` (resolved via `getIsccServiceUrlByConfig`) points at an
`iscc-web` service used for one purpose only: **ISCC code generation** —
`GET /api/v1/generateIsccFromUrl` creates an ISCC code from media at a URL (`…/api/v1/create`).
ISCC *resolution* for indexing/search happens inside the external search service, not here.

**`IsccStack`** (ECS Fargate) provisions an [`iscc-web`](https://github.com/iscc/iscc-web)
deployment behind an ALB (its DNS name is a stack output); point `ISCC_HOST` at it.
