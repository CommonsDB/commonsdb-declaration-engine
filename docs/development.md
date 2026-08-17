# Development guide

## Workspace layout

pnpm workspace with two packages plus the infrastructure code at the root:

- **`packages/core`** (`@commonsdb/core`) — all domain logic. Import style:
  `@commonsdb/core/<dir>/<file>` (path-mapped to `packages/core/src/*` in the tsconfigs; esbuild
  honors the same mapping when bundling Lambdas).
- **`packages/functions`** (`@commonsdb/functions`) — Lambda handlers only. Handlers should stay
  thin: parse/auth/validate, call into core, shape the HTTP response.
- **`stacks/`** — SST constructs. `CommonsDBStack.ts` is the single source of truth for
  resources, bindings, and routes.

Key core modules:

| Module | Responsibility |
|---|---|
| `interfaces/commonInterfaces.ts` | **Canonical types** (`IDeclarationPayload`, `IDeclarationMetaInternal`, …). The only place to define declaration shapes. |
| `utils/fieldMapping.ts` | Dynamic identifier field resolution (see configuration.md) |
| `utils/declarationUtils.ts` / `tsaCryptoUtil.ts` | Declaration normalization, RFC 3161 parsing (DID/JWK handling lives in `ingest.ts`) |
| `searchUtils/indexingUtils.ts` | The indexing pipeline (`processIsccStringRaw`) — the heart of the Kinesis consumer |
|  `searchUtils/searchServiceClient.ts` | HTTP client for the external search service — the *only* module that talks to it |
| `searchUtils/table*Util.ts` | One helper module per DynamoDB table; handlers never call DynamoDB directly |
| `searchUtils/s3Util.ts` | Declaration JSON persistence/retrieval |
| `searchUtils/notifyUtil.ts` | Slack notifications + rate limiting |
| `statistics/` | `cdb_stats` Postgres sync and queries |

## Local development

```bash
pnpm dev:stag       # sst dev --stage staging
```

`sst dev` deploys *live-Lambda* stubs: requests hitting the staging APIs execute your local code
with hot reload, logs stream to the terminal, and SST bindings (secrets, table names) resolve
against the staging stage. Use a personal stage (`npx sst dev --stage <yourname>`) if you need
isolation from shared staging — remember to set the secrets for it first.

## Coding conventions

- **ES modules everywhere** (`"type": "module"`); `import`/`export`, never `require()`.
- **No `process.env` in runtime code** — `Config.*` from `sst/node/config` only, with a matching
  binding in the stack (see [configuration.md](configuration.md)).
- **Table access via SST bindings** — `Table.<name>.tableName`; never hardcode names.
- **AWS SDK v3** (`@aws-sdk/*`) for all new code. The root `aws-sdk` v2 dependency exists for
  legacy code only; do not add new v2 usage.
- **Kinesis consumer error handling** — inside `declarationProcessor` / `indexingUtils`, hard
  errors must **propagate** (they drive the partial-batch retry + Slack alert). Only explicitly
  best-effort side effects (analytics, registry mirror, stats sync) may swallow errors, and they
  must log them.
- Validation: a custom JSON-Schema validator (`validateAgainstJsonSchema` in `ingest.ts`) for the
  ingest schema.
- Formatting: Prettier, 2-space indent, 120-char width (`.prettierrc`).
- Logging: `console.log`/`console.error` with structured objects (CloudWatch is the only
  debugger in production). Prefer `JSON.stringify` payloads over string concatenation.
- Naming: several persisted attribute names carry historical "Milvus" naming
  (`DYNAMO_MILVUSMAP_*`, `ItemID`). They are **data-compatible names** — renaming requires
  a coordinated migration; leave them.

## Type checking & tests

```bash
pnpm typecheck                        # root: tsc --noEmit across the workspace (the CI gate)

# unit tests (Vitest) — offline, from the repo root across workspaces
pnpm test                            # plain `vitest run`, no SST bindings needed

# integration tests (Jest over HTTP) — staging ONLY, needs a deployed API_BASE_URL
cd integration-tests && cp env.template .env && npm install && npm test
```

Notes:

- `pnpm typecheck` requires generated SST types; run `npx sst build --stage staging` once on a
  fresh clone.
- `integration-tests/` is excluded from the root typecheck (it has its own tsconfig and Jest
  globals).
- Never point integration tests at production.

## Adding a new API route (checklist)

1. Handler in `packages/functions/src/<name>.ts` (`ApiHandler`, auth check first, validate
   inputs).
2. Route entry in the appropriate `Api` construct in `stacks/CommonsDBStack.ts`.
3. Bind every `Config.*`/`Table.*`/`Bucket.*` the handler touches (route-level `bind` or API
   defaults).
4. `pnpm typecheck`, deploy to staging, add an integration test.

## Adding a declaration metadata field (checklist)

1. Extend the canonical interface in `packages/core/src/interfaces/commonInterfaces.ts`.
2. Extend the JSON Schema: the inline `LOCAL_SCHEMA` in `packages/functions/src/ingest.ts` (the
   authoritative schema), and update the example in `schemas/v0.2.0/`.
3. Check downstream consumers: censoring logic in `search.ts` (what is exposed), indexing
   (`indexingUtils.ts`), stats sync mapping.
4. Published declarations validate against their declared schema version — new required fields
   can only go into a new schema version (current: v0.2.0).

## Deployment

```bash
./deploy-staging.sh    # refuses a dirty tree, offers to push, deploys staging
./deploy-prod.sh       # same guards + confirmation, deploys cdb-b2b-api-prod
```

There is **no CI/CD pipeline** — deploys are manual. Before deploying: `pnpm typecheck` and a
green integration-test run against staging.

## Utility scripts

| Script | Purpose |
|---|---|
| `scripts/backfillIrohRegistry.ts` (`pnpm backfill:iroh-registry`) | Reconciles all declarations into the external iroh registry stream |
| `scripts/verifyIrohRegistry.ts` (`pnpm verify:iroh-registry`) | Verifies registry completeness |
| `scripts/redact.sh` | Curl wrapper for bulk redaction calls (fill in `AUTH_KEY`/`API_URL` locally — never commit them) |
