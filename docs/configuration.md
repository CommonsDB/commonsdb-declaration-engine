# Configuration reference

All runtime configuration flows through SST's typed config system
(`import { Config } from "sst/node/config"`). **Never** read `process.env` in Lambda code: values
are only available to a function if the corresponding Secret/Parameter is *bound* to it in
`stacks/CommonsDBStack.ts`, and access to an unbound key throws at runtime.

- **Secrets** live in SSM Parameter Store, set per stage via
  `npx sst secret set <NAME> <value> --stage <stage>`; never in code.
- **Parameters** are plain values defined in `stacks/CommonsDBStack.ts` (some per-stage
  conditionals) and change only via code + deploy.

## Secrets

| Secret | Consumed by | Purpose / notes |
|---|---|---|
| `SECRET_SEARCH_SERVICE_API_KEY` | `searchServiceClient.ts` (search handlers) | Shared key sent as `x-api-key` to the search service query API. Must match the service's configured key. Rotate by updating both sides. |
| `SECRET_SLACK_WEBHOOK_URL` | `notifyUtil.ts` (indexer, search API lambdas, all crons) | Slack incoming-webhook URL for ops notifications. Rotation = set new secret + redeploy (bindings refresh on deploy). |
| `SECRET_ZUPLO_ACCESS_KEY` | ingest + most search/lookup/redact handlers, customer-keys API | Internal API key #1, expected in `x-api-key`. Injected by the fronting gateway in production. |
| `SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B` | `searchIscc.ts`, `statistics.ts` | Internal API key #2 for the B2B search surface. |
| `SECRET_IDENTIFIER_FIELD_KEY_NAME` | `fieldMapping.ts` → nearly all handlers | Name of the dynamic identifier field (`cidV1` or `cidV2`). **Changing it re-keys lookups** — existing DynamoDB rows keep the old attribute; do not change on a live stage. |
| `SECRET_TRUSTED_DECLARER_KEYS` | `ingest.ts` (also covers `direct-ingest`) | JSON map `{"<did:key>": "<PEM public key>"}` — pinned-key fallback for JWT verification when a declaration carries no embedded JWK. `_` or invalid JSON = pinning disabled. PEM newlines are regular `\n` JSON escapes. |
| `SECRET_VALIDATION_BYPASS_DECLARERS` | `ingest.ts` | Comma-separated declarer ids that skip strict ingest validation (declarerId consistency + signature/TSA verification). `_` = none. Keep empty on public deployments. |
| `SECRET_SLACK_NOTIFY_RULES` | `notifyUtil.ts` | JSON array of per-key notification rules: `[{"key":"…","block":true}, {"key":"…","rateLimit":{"max":5,"windowMs":600000}}]`. Keys match `companyId` by substring. `_` = no per-key rules. |
| `RANDOM_DECLARER_ID_DENYLIST` | `getRandom.ts`, `statistics.ts` | Comma-separated declarer DIDs excluded from `GET /random` and from statistics (secret so internal declarer ids stay out of the repo). `_` = none. |
| `SECRET_ENCRYPTION_KEY` | `customer-keys/customerKeys.ts` | Symmetric key encrypting customer private keys in the `customerKeys` table. Changing it orphans previously encrypted rows. |
| `SECRET_CDB_STATS_PG_URL` | `statistics.ts`, `statsSyncUtil.ts` (indexer), `refreshStatsViews` cron | Postgres connection string for the `cdb_stats` database. |

## Parameters

| Parameter | Default | Consumed by | Purpose / notes |
|---|---|---|---|
| `SEARCH_SERVICE_URL` | *placeholder — must be set* | `searchServiceClient.ts` (search handlers) | Base URL of the search service query API. |
| `SEARCH_INDEX_STREAM_NAME` | `<stage>-commonsdb-serverless-search` | `searchIndexProducer.ts` (ingest pipeline; also stored as `storageHost` metadata) | Kinesis index stream of the sibling search deployment. `_` disables emission (stages without a search deployment). PutRecord IAM grant is attached explicitly in the stack. |
| `ISCC_HOST` | placeholder | `isccGen/generatorUtil.ts` (via `isccServiceSelector.ts`) | `iscc-web` service URL — used only by `GET /generateIsccFromUrl`. |
| `VERSION` | `1.0.0` | Most handlers (echoed in responses) | API/schema version marker. |
| `MIN_DECLARATION_TIMESTAMP` | `2026-01-09` | search filtering, `statistics.ts` | Declarations with an older `publicMetadata.timestamp` are hidden from search results and excluded from statistics. Not an ingest gate (ingest enforces a 60-second server-time window instead). |
| `DECLARER_ID_DENYLIST` | `_` | search handlers | Comma-separated declarer DIDs removed from search results. `_` = no-op (SSM forbids empty strings). |
| `IROH_REGISTRY_STREAM_NAME` | prod stream name on `cdb-b2b-api-prod`, else `_` | `irohRegistryUtil.ts` (indexer, redact) | External Kinesis stream for registry mirroring; `_` disables. IAM put-access to the stream ARN is granted explicitly in the stack. |
| `CDB_STATS_DYNAMO_TABLE` | `cdb_processed_declarations` | `statsSyncUtil.ts` | External de-dup marker table of the stats batch pipeline (managed outside SST; explicit IAM grant in stack). |
| `KINESIS_SHARD_ID` | `shardId-000000000000` | — (unused) | Bound to functions but **never read in code**; reserved. Shard identity placeholder for the declaration stream. |
| `DYNAMO_MILVUSMAP_KEY_NAME` | `ItemID` | indexer, lookup utils | Attribute name of the vector-id key in `vectorToDataMap` (historical "Milvus" naming — renaming requires a coordinated data migration; don't). |
| `DYNAMO_MILVUSMAP_ATTRIBUTE_NAME` | `S3Path` | indexer, lookup utils | Attribute name of the S3-path value in `vectorToDataMap`. |

## Built-ins

`Config.APP` and `Config.STAGE` are provided by SST. Stage-dependent behavior in code:

- `notifyUtil.ts` — notifications suppressed when `STAGE === "dev"`; message header shows
  *COMMONS DB PROD* for `cdb-b2b-api-prod`, otherwise *COMMONS DB (<stage>)*.
- `CommonsDBStack.ts` — `IROH_REGISTRY_STREAM_NAME` enabled only on `cdb-b2b-api-prod`.

## Binding map (who can read what)

Bindings are declared per function group in `stacks/CommonsDBStack.ts`; the important ones:

| Function group | Notable bindings |
|---|---|
| Kinesis consumer (`declarationProcessor`) | search index stream name, Slack webhook, all data tables, S3 bucket, stats PG URL, iroh stream name |
| Search API defaults | both Zuplo keys, search-service key/URL, Slack webhook, data tables, S3 bucket |
| Ingest API defaults | primary Zuplo key, Kinesis stream, status/identifier tables |
| Customer-keys API | encryption key, primary Zuplo key, `customerKeys` table |
| Crons | Slack webhook + job-specific tables (`/statistics` route and `refreshStatsViews` additionally bind the PG URL and bundle `pg`) |

When adding a new handler that reads a `Config.*` key, **add the binding** to its function (or
the API's `defaults.function.bind`) — otherwise it throws `<key> is not bound` at runtime.
