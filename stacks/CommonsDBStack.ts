import { StackContext, Api, EventBus, Config, Bucket, KinesisStream, Table, Cron } from "sst/constructs";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";

export async function API({ stack }: StackContext) {
  const P: (name: string, val: string) => Config.Parameter = (name: string, val: string) =>
    new Config.Parameter(stack, name, { value: val });
  const __SECRET__ = (name: string) => new Config.Secret(stack, name);

  const SECRET_ENCRYPTION_KEY = __SECRET__("SECRET_ENCRYPTION_KEY");
  // Shared key for the commonsdb-search-serverless service (sent as x-api-key).
  // All similarity-index internals live in that separate project.
  const SECRET_SEARCH_SERVICE_API_KEY = __SECRET__("SECRET_SEARCH_SERVICE_API_KEY");
  // Slack incoming-webhook URL for ops notifications (was hardcoded before the
  // public release; set via `sst secret set SECRET_SLACK_WEBHOOK_URL <url>`).
  const SECRET_SLACK_WEBHOOK_URL = __SECRET__("SECRET_SLACK_WEBHOOK_URL");
  const SECRET_ZUPLO_ACCESS_KEY = __SECRET__("SECRET_ZUPLO_ACCESS_KEY");
  const SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B = __SECRET__("SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B");
  // JSON map of declarer DID → PEM public key used by ingest as a pinned-key
  // fallback when a declaration JWT has no embedded JWK. "_" disables pinning.
  const SECRET_TRUSTED_DECLARER_KEYS = __SECRET__("SECRET_TRUSTED_DECLARER_KEYS");
  // Comma-separated declarer ids allowed to skip strict ingest validation
  // (declarerId consistency + signature/TSA verification). "_" = none.
  const SECRET_VALIDATION_BYPASS_DECLARERS = __SECRET__("SECRET_VALIDATION_BYPASS_DECLARERS");
  // JSON array of per-key Slack notification rules (block / rate-limit
  // overrides), see notifyUtil.ts. "_" = no per-key rules.
  const SECRET_SLACK_NOTIFY_RULES = __SECRET__("SECRET_SLACK_NOTIFY_RULES");
  // Comma-separated declarerIds excluded from GET /random. Held as a secret so
  // the (internal) declarer ids stay out of the repository. "_" = none.
  const SECRET_RANDOM_DECLARER_ID_DENYLIST = new Config.Secret(stack, "RANDOM_DECLARER_ID_DENYLIST");
  const SECRET_IDENTIFIER_FIELD_KEY_NAME = __SECRET__("SECRET_IDENTIFIER_FIELD_KEY_NAME");
  // Connection string for the cdb_stats Postgres DB (populated by the
  // commons-db-statistics pipeline). Used by the /statistics endpoint and the
  // ingest pipeline's live sync.
  const SECRET_CDB_STATS_PG_URL = __SECRET__("SECRET_CDB_STATS_PG_URL");

  const stageName = stack.stage;
  // Print the stage name
  console.log(`API initialize function, stack.STAGE is: ${stageName}`);

  const PARAM_VERSION = P("VERSION", "1.0.0");
  const PARAM_MIN_DECLARATION_TIMESTAMP = P("MIN_DECLARATION_TIMESTAMP", "2026-01-09"); // 9th January 2026
  const PARAM_DECLARER_ID_DENYLIST = P("DECLARER_ID_DENYLIST", "_"); // comma-separated list of declarerIds to exclude from search results; use "_" as a no-op placeholder (SSM does not allow empty strings)
  // Base URL of the iscc-web service (see stacks/ISCCStack.ts). Set per stage to
  // the ISCCStack ALB output. Kept as a placeholder in source so no
  // environment-specific host is committed.
  const PARAM_ISCC_HOST = P("ISCC_HOST", "http://REPLACE-WITH-ISCC-WEB-HOST");
  // URL of the search service's QUERY API (deployed separately). Used only by
  // the interactive search endpoints; indexing goes via Kinesis (below).
  // Update the value after deploying the search service for this stage.
  const PARAM_SEARCH_SERVICE_URL = P(
    "SEARCH_SERVICE_URL",
    "https://REPLACE-WITH-SEARCH-SERVICE-URL.execute-api.eu-central-1.amazonaws.com",
  );
  // Kinesis index stream of the sibling search deployment (provisioned by its
  // own SST app, not by this stack). The declaration processor emits one
  // { itemId, iscc } event per declaration; the search service consumes it.
  // "_" disables emission on stages without a search deployment.
  const PARAM_SEARCH_INDEX_STREAM_NAME = P("SEARCH_INDEX_STREAM_NAME", `${stageName}-commonsdb-serverless-search`);
  // DynamoDB de-dup table owned by the commons-db-statistics pipeline. The
  // ingest live sync writes a "processed" marker here so the batch backfill
  // skips files already indexed in real time.
  const PARAM_CDB_STATS_DYNAMO_TABLE = P("CDB_STATS_DYNAMO_TABLE", "cdb_processed_declarations");
  // External ingestion stream of the iroh-registry-api project (same
  // account, provisioned by its Terraform, not by SST). Declarations are
  // mirrored into the registry through it. "_" disables mirroring on stages
  // that have no registry deployment (SSM does not allow empty strings).
  const PARAM_IROH_REGISTRY_STREAM_NAME = P(
    "IROH_REGISTRY_STREAM_NAME",
    stageName === "cdb-b2b-api-prod" ? "cdb-b2b-prod-registry-external-ingestion" : "_",
  );
  const PARAM_KINESIS_SHARD_ID = P("KINESIS_SHARD_ID", "shardId-000000000000");
  const PARAM_DYNAMO_MILVUSMAP_KEY_NAME = P("DYNAMO_MILVUSMAP_KEY_NAME", "ItemID");
  const PARAM_DYNAMO_MILVUSMAP_ATTR = P("DYNAMO_MILVUSMAP_ATTRIBUTE_NAME", "S3Path");

  const BUS_main = new EventBus(stack, "bus", {
    defaults: {
      retries: 10,
    },
  });

  // create dynamo db:
  const TABLE_IDENTIFIERS_OF_DECLARATION = new Table(stack, "IdentifiersOfDeclaration", {
    fields: {
      identifier: "string",
      cid: "string",
      S3Path: "string",
      content: "string",
    },
    primaryIndex: { partitionKey: "identifier" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });
  const TABLE_REDACTED = new Table(stack, "Redacted", {
    fields: {
      identifier: "string",
      redacted: "number",
    },
    primaryIndex: { partitionKey: "identifier" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });
  const TABLE_REDACTED_PRODUCTS = new Table(stack, "RedactedProducts", {
    fields: {
      productId: "string",
      redacted: "number",
    },
    primaryIndex: { partitionKey: "productId" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });
  const TABLE_CIDs = new Table(stack, "CIDs", {
    fields: {
      cid: "string",
      content: "string",
      s3Path: "string",
    },
    primaryIndex: { partitionKey: "cid" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  // Declaration processing status tracking table
  const TABLE_declarationStatus = new Table(stack, "DeclarationStatus", {
    fields: {
      identifier: "string",
      status: "string", // pending, success, failed
      message: "string",
      createdAt: "number",
      updatedAt: "number",
    },
    primaryIndex: { partitionKey: "identifier" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  // Superseded declarations tracking table
  // Tracks which declarations have been superseded by newer ones
  const TABLE_supersededDeclarations = new Table(stack, "SupersededDeclarations", {
    fields: {
      identifier: "string", // The identifier of the superseded declaration
      supersededBy: "string", // The identifier of the declaration that superseded it
      supersededAt: "number", // Timestamp when it was superseded
    },
    primaryIndex: { partitionKey: "identifier" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  const TABLE_customerKeys = new Table(stack, "customerKeys", {
    fields: {
      customerId: "string",
      encryptedKey: "string",
    },
    primaryIndex: { partitionKey: "customerId" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  // Shared rate-limit state for Slack notifications.
  // Replaces the previous in-memory Map, which could not enforce a global limit
  // across the many parallel / frequently-recycled Kinesis consumer containers.
  // PK = key (companyId / declarerId). `expireAt` is a Unix-seconds TTL for cleanup.
  const TABLE_slackRateLimit = new Table(stack, "SlackRateLimit", {
    fields: {
      key: "string",
      count: "number",
      windowStart: "number", // epoch ms when the current window started
      expireAt: "number", // epoch seconds — DynamoDB TTL
    },
    primaryIndex: { partitionKey: "key" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "expireAt",
      },
    },
  });

  // Stores per-declarer API-key registrations for the direct-ingest endpoint.
  // PK = declarerId (did:key) — enforces one registration per did:key.
  const TABLE_directIngestRegistrations = new Table(stack, "directIngestRegistrations", {
    fields: {
      declarerId: "string",
    },
    primaryIndex: { partitionKey: "declarerId" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  // Analytics counters table for real-time metrics
  const TABLE_analyticsCounters = new Table(stack, "AnalyticsCounters", {
    fields: {
      counterKey: "string",
      counterValue: "number",
      lastUpdated: "number",
      metadata: "string", // JSON string for additional data
    },
    primaryIndex: { partitionKey: "counterKey" },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });
  const API_customerKeysApi = new Api(stack, "customerKeysApi", {
    defaults: {
      function: {
        bind: [SECRET_ENCRYPTION_KEY, SECRET_ZUPLO_ACCESS_KEY, TABLE_customerKeys],
      },
    },
    routes: {
      "POST /generateKey": "packages/functions/src/customerKeysFn.generateKey",
      "GET /getDecryptedKey": "packages/functions/src/customerKeysFn.getDecryptedKey",
    },
  });

  const S3BUCKET_RegistryData = new Bucket(stack, "declarationData", {
    cdk: {
      bucket: {
        bucketName: stack.stage + "-commonsdb-declaration-data",
        versioned: true,
        publicReadAccess: false,
      },
    },
  });

  const TABLE_vectorToDataMap = new Table(stack, "vectorToDataMap", {
    fields: {
      ItemID: "string",
      S3Path: "string",
      timestamp: "number",
      type: "string", // A constant value to group all records for GSI
    },
    primaryIndex: { partitionKey: "ItemID" },
    globalIndexes: {
      timestampIndex: {
        partitionKey: "type",
        sortKey: "timestamp",
      },
    },
    cdk: {
      table: {
        billingMode: BillingMode.PAY_PER_REQUEST,
      },
    },
  });

  const kinesis_declarationStream = new KinesisStream(stack, "declarationStream", {
    defaults: {
      function: {
        bind: [
          SECRET_SLACK_WEBHOOK_URL,
          SECRET_SLACK_NOTIFY_RULES,
          SECRET_IDENTIFIER_FIELD_KEY_NAME,

          BUS_main,

          TABLE_vectorToDataMap,
          TABLE_CIDs,
          TABLE_REDACTED,
          TABLE_REDACTED_PRODUCTS,
          TABLE_IDENTIFIERS_OF_DECLARATION,
          TABLE_analyticsCounters,
          TABLE_declarationStatus,
          TABLE_supersededDeclarations,
          TABLE_slackRateLimit,

          S3BUCKET_RegistryData,
          PARAM_DYNAMO_MILVUSMAP_KEY_NAME,
          PARAM_DYNAMO_MILVUSMAP_ATTR,
          PARAM_VERSION,
          PARAM_KINESIS_SHARD_ID,
          PARAM_SEARCH_INDEX_STREAM_NAME,

          SECRET_CDB_STATS_PG_URL,
          PARAM_CDB_STATS_DYNAMO_TABLE,
          PARAM_IROH_REGISTRY_STREAM_NAME,
        ],
      },
    },
    consumers: {
      consumerIndexer: {
        function: {
          handler: "packages/functions/src/declarationProcessor.handler",
          // Increase memory for faster processing (also increases CPU proportionally)
          memorySize: 1024,
          // Increase timeout to handle external API calls (Vector API, ISCC host, S3)
          timeout: "120 seconds",
          // Bundle the Postgres driver (used by the cdb_stats live sync).
          nodejs: { install: ["pg"] },
        },
        cdk: {
          eventSource: {
            // Process smaller batches for faster individual record processing
            batchSize: 10,
            // Allow up to 10 parallel Lambda invocations per shard
            parallelizationFactor: 10,
            // Start from latest to avoid reprocessing old stuck records.
            // aws-cdk-lib is required inline (not imported) because two versions
            // resolve in this workspace (root 2.124 vs SST-bundled); the runtime
            // require picks the one the KinesisStream construct expects.
            startingPosition: require("aws-cdk-lib/aws-lambda").StartingPosition.LATEST,
            // On error, split batch in half to isolate bad records
            bisectBatchOnError: true,
            // Max time to wait before invoking with partial batch
            maxBatchingWindow: require("aws-cdk-lib").Duration.seconds(5),
            // Max retries before sending to DLQ or dropping
            retryAttempts: 3,
            // Enable partial batch response to only retry failed records
            reportBatchItemFailures: true,
          },
        },
      },
    },
  });

  // The cdb_processed_declarations table is managed outside SST (by the
  // commons-db-statistics project), so grant the indexer explicit write access.
  // Cast the statement: two aws-cdk-lib versions resolve in this workspace
  // (root 2.124 vs SST-bundled), which only differ nominally for this type.
  const cdbStatsDynamoPolicy = new iam.PolicyStatement({
    actions: ["dynamodb:PutItem"],
    resources: [`arn:aws:dynamodb:${stack.region}:${stack.account}:table/cdb_processed_declarations`],
  });
  kinesis_declarationStream.getFunction("consumerIndexer")?.attachPermissions([cdbStatsDynamoPolicy as any]);

  // The iroh-registry external ingestion stream is likewise managed outside
  // SST (iroh-registry-api Terraform), so put access is granted explicitly.
  // Attached to the indexer (mirrors new declarations) and, below, to the
  // redact route (mirrors redactions).
  const irohRegistryKinesisPolicy = new iam.PolicyStatement({
    actions: ["kinesis:PutRecord", "kinesis:PutRecords"],
    resources: [`arn:aws:kinesis:${stack.region}:${stack.account}:stream/cdb-b2b-prod-registry-external-ingestion`],
  });
  kinesis_declarationStream.getFunction("consumerIndexer")?.attachPermissions([irohRegistryKinesisPolicy as any]);

  // The search index stream is owned by the sibling search deployment (its own
  // SST app), so put access is granted explicitly by name.
  const searchIndexKinesisPolicy = new iam.PolicyStatement({
    actions: ["kinesis:PutRecord", "kinesis:PutRecords"],
    resources: [`arn:aws:kinesis:${stack.region}:${stack.account}:stream/${stageName}-commonsdb-serverless-search`],
  });
  kinesis_declarationStream.getFunction("consumerIndexer")?.attachPermissions([searchIndexKinesisPolicy as any]);

  const api_searchApi = new Api(stack, "searchApi", {
    defaults: {
      function: {
        bind: [
          SECRET_SEARCH_SERVICE_API_KEY,
          SECRET_SLACK_WEBHOOK_URL,
          SECRET_SLACK_NOTIFY_RULES,
          SECRET_ZUPLO_ACCESS_KEY,
          SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B,
          SECRET_IDENTIFIER_FIELD_KEY_NAME,
          SECRET_RANDOM_DECLARER_ID_DENYLIST,

          BUS_main,

          S3BUCKET_RegistryData,

          TABLE_CIDs,
          TABLE_vectorToDataMap,
          TABLE_REDACTED,
          TABLE_REDACTED_PRODUCTS,
          TABLE_IDENTIFIERS_OF_DECLARATION,
          TABLE_analyticsCounters,
          TABLE_declarationStatus,
          TABLE_supersededDeclarations,
          TABLE_slackRateLimit,

          PARAM_VERSION,
          PARAM_MIN_DECLARATION_TIMESTAMP,
          PARAM_DECLARER_ID_DENYLIST,
          PARAM_SEARCH_SERVICE_URL,
          PARAM_DYNAMO_MILVUSMAP_KEY_NAME,
          PARAM_DYNAMO_MILVUSMAP_ATTR,
          PARAM_ISCC_HOST,
          PARAM_IROH_REGISTRY_STREAM_NAME,
        ],
      },
    },
    routes: {
      "GET /api/v1/search": "packages/functions/src/search.search",
      "GET /api/v1/search-iscc": "packages/functions/src/searchIscc.searchIscc",
      "GET /api/v1/getByCid": "packages/functions/src/getByCid.getByCid",
      "GET /api/v1/getByDecId": "packages/functions/src/getByDecId.getByDecId",
      "GET /api/v1/generateIsccFromUrl": "packages/functions/src/isccGeneratorFn.IsccFromUrl",
      "POST /api/v1/redact": "packages/functions/src/redact.redact",
      "GET /api/v1/latest": "packages/functions/src/getLatest.getLatest",
      "GET /api/v1/random": "packages/functions/src/getRandom.getRandom",
      "GET /api/v1/uniqueIsccCount": {
        function: {
          handler: "packages/functions/src/getUniqueIsccAmount.getUniqueIsccAmount",
          timeout: "60 seconds",
        },
      },
      "GET /api/v1/getFullById": "packages/functions/src/getFullMetadataByIdentifier.getFullMetadataByIdentifier",
      "GET /api/v1/searchDeclarer": "packages/functions/src/searchByDeclarer.searchByDeclarer",
      "GET /api/v1/fullCount": {
        function: {
          handler: "packages/functions/src/getFullDeclarationsAmount.getFullDeclarationsAmount",
          timeout: "30 seconds",
        },
      },
      "POST /api/v1/recalculateAnalytics": {
        function: {
          handler: "packages/functions/src/cron/analyticsRecalculation.testHandler",
          timeout: "15 minutes",
        },
      },
      "POST /api/v1/setupAnalytics": {
        function: {
          handler: "packages/functions/src/setupAnalytics.setupAnalytics",
          timeout: "15 minutes",
        },
      },
      "GET /api/v1/analyticsStatus": "packages/functions/src/setupAnalytics.getAnalyticsStatus",
      "GET /api/v1/statistics": {
        function: {
          handler: "packages/functions/src/statistics.statistics",
          timeout: "30 seconds",
          // pg ships optional native bindings; install it into the bundle rather
          // than letting esbuild try to bundle them.
          nodejs: { install: ["pg"] },
          bind: [SECRET_CDB_STATS_PG_URL],
        },
      },
      "GET /api/v1/getByIdentifier": "packages/functions/src/getByIdentifier.getByIdentifier",
      "GET /api/v1/getDeclarationStatus": "packages/functions/src/getDeclarationStatus.getDeclarationStatus",
      "POST /api/v1/cleanupStalePending": {
        function: {
          handler: "packages/functions/src/cron/stalePendingCleanup.testHandler",
          timeout: "5 minutes",
        },
      },
    },
  });
  // The redact route mirrors redactions/un-redactions into the iroh registry.
  api_searchApi.getFunction("POST /api/v1/redact")?.attachPermissions([irohRegistryKinesisPolicy as any]);

  const api_ingestApi = new Api(stack, "ingestApi", {
    defaults: {
      function: {
        bind: [
          SECRET_ZUPLO_ACCESS_KEY,
          SECRET_IDENTIFIER_FIELD_KEY_NAME,
          SECRET_TRUSTED_DECLARER_KEYS,
          SECRET_VALIDATION_BYPASS_DECLARERS,

          BUS_main,

          kinesis_declarationStream,

          TABLE_directIngestRegistrations,
          TABLE_declarationStatus,
          TABLE_IDENTIFIERS_OF_DECLARATION,
          TABLE_supersededDeclarations,

          PARAM_DYNAMO_MILVUSMAP_KEY_NAME,
          PARAM_DYNAMO_MILVUSMAP_ATTR,
          PARAM_VERSION,
          PARAM_KINESIS_SHARD_ID,
        ],
      },
    },
    routes: {
      "POST /api/v1/ingest": "packages/functions/src/ingest.ingest",
      // Direct-ingest: Zuplo-free path for declarers registered in DynamoDB.
      // Auth is handled inside the handler (API key hash + JWK check) before
      // forwarding to the original ingest function.
      "POST /api/v1/direct-ingest": "packages/functions/src/directIngest.directIngest",
      // Direct-status: Zuplo-free status polling for declarers registered in DynamoDB.
      // Auth: x-declarer-id header + x-api-key hash check, then forwards to getDeclarationStatus.
      "GET /api/v1/direct-status": "packages/functions/src/directStatus.directStatus",
    },
  });

  // Cron job for periodic analytics recalculation
  const CRON_analyticsRecalculation = new Cron(stack, "AnalyticsRecalculation", {
    schedule: "rate(48 hours)",
    job: {
      function: {
        handler: "packages/functions/src/cron/analyticsRecalculation.handler",
        timeout: "15 minutes",
        bind: [
          SECRET_ZUPLO_ACCESS_KEY,
          SECRET_SLACK_WEBHOOK_URL,
          TABLE_analyticsCounters,
          TABLE_slackRateLimit,
          S3BUCKET_RegistryData,
          PARAM_VERSION,
        ],
      },
    },
  });

  // Cron job to cleanup stale pending declarations (runs every 15 minutes)
  // Declarations stuck in "pending" for more than 1 hour are marked as "failed"
  const CRON_stalePendingCleanup = new Cron(stack, "StalePendingCleanup", {
    schedule: "rate(15 minutes)",
    job: {
      function: {
        handler: "packages/functions/src/cron/stalePendingCleanup.handler",
        timeout: "5 minutes",
        bind: [SECRET_SLACK_WEBHOOK_URL, TABLE_declarationStatus, TABLE_slackRateLimit, PARAM_VERSION],
      },
    },
  });

  // Cron job for the periodic drift-correction rebuild of the incremental
  // stats tables. The dashboard reads stats_daily_unique/stats_media_unique,
  // which a declarations trigger keeps current on every ingest — this rebuild
  // is only a safety net, so a few runs a day are plenty. A run that exceeds
  // the 15-minute Lambda cap rolls back harmlessly.
  const CRON_refreshStatsViews = new Cron(stack, "RefreshStatsViews", {
    schedule: "rate(12 hours)",
    job: {
      function: {
        handler: "packages/functions/src/cron/refreshStatsViews.handler",
        timeout: "15 minutes",
        nodejs: { install: ["pg"] },
        bind: [SECRET_CDB_STATS_PG_URL, SECRET_SLACK_WEBHOOK_URL, TABLE_slackRateLimit, PARAM_VERSION],
      },
    },
  });

  // Add EventBridge rule to trigger analytics recalculation on demand
  BUS_main.addRules(stack, {
    analyticsRecalculationRule: {
      pattern: {
        source: ["commonsdb.analytics"],
        detailType: ["Analytics Recalculation Request"],
      },
      targets: {
        analyticsRecalculation: CRON_analyticsRecalculation.jobFunction,
      },
    },
  });

  stack.addOutputs({
    API_ingestApi: api_ingestApi.url,
    API_searchApi: api_searchApi.url,
    API_customerKeysApi: API_customerKeysApi.url,
    KINESIS_declarationStream: kinesis_declarationStream.streamName,
    KINESIS_declarationStreamArn: kinesis_declarationStream.streamArn,
    TABLE_customerKeys: TABLE_customerKeys.tableName,
    TABLE_vectorToDataMap: TABLE_vectorToDataMap.tableName,
    TABLE_analyticsCounters: TABLE_analyticsCounters.tableName,
    TABLE_declarationStatus: TABLE_declarationStatus.tableName,
    TABLE_supersededDeclarations: TABLE_supersededDeclarations.tableName,
    CRON_analyticsRecalculation: CRON_analyticsRecalculation.id,
    CRON_stalePendingCleanup: CRON_stalePendingCleanup.id,
    CRON_refreshStatsViews: CRON_refreshStatsViews.id,
    ISCC_HOST: PARAM_ISCC_HOST,
    MIN_DECLARATION_TIMESTAMP: PARAM_MIN_DECLARATION_TIMESTAMP,
    DECLARER_ID_DENYLIST: PARAM_DECLARER_ID_DENYLIST,
  });
}
