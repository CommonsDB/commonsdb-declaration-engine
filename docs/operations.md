# Operations runbook

## Monitoring & alerting (current state)

| Signal | Where |
|---|---|
| Application logs | CloudWatch Logs, one group per Lambda. `npx sst console --stage <stage>` gives a unified view. |
| Errors in the ingest pipeline | **Slack** (webhook `SECRET_SLACK_WEBHOOK_URL`): the Kinesis consumer posts an error message per failed record. **This is the only alert channel.** |
| Ingest success notifications | Slack (rate-limited per company via the `SlackRateLimit` table; suppressed on `dev`) |
| Declaration progress | `DeclarationStatus` table / `GET /api/v1/getDeclarationStatus` (`pending` → `success` \| `failed`) |

## Known gaps (accepted risks — prioritized)

| Gap | Impact | Mitigation until fixed |
|---|---|---|
| **No dead-letter queue on the Kinesis consumer** | A record that fails all 3 retries is dropped; the Slack error is the only trace | Watch Slack; re-submit the declaration (ingest is safe to repeat). Long-term: add an SQS DLQ + redrive. |
| No CI/CD | Deploys are manual shell scripts | Guards in `deploy-*.sh` (clean tree, confirmation) |
| No ESLint | `pnpm typecheck` is the only static gate | Keep typecheck green; add `@typescript-eslint` eventually |
| No tracing/metrics (X-Ray, Powertools) | Debugging is log-diving | Structured `console.log` payloads |
| Customer key encryption is a single symmetric secret | `SECRET_ENCRYPTION_KEY` compromise exposes stored keys | Restrict who can read SSM for prod; consider KMS envelope encryption |

## Troubleshooting

### A declaration is stuck in `pending`

1. `GET /api/v1/getDeclarationStatus?cidV1=<id>` — confirm state and `updatedAt`.
2. Check the `declarationProcessor` CloudWatch logs around submission time; search for the rayId
   logged at ingest.
3. Typical causes: search index stream missing (PutRecord fails — was the search app deployed
   with the same stage name?), S3/DynamoDB errors —
   HTTP 401/5xx in logs), S3/DynamoDB permissions after a stack change.
4. The `StalePendingCleanup` cron marks records `failed` after ~1 h so they surface; once the
   root cause is fixed, **re-submit the declaration** (there is no replay from Kinesis).

### Search returns no results for a known declaration

1. Confirm the declaration status is `success`.
2. Confirm it's not filtered: redacted (`Redacted`/`RedactedProducts`), declarer on
   `DECLARER_ID_DENYLIST`, timestamp older than `MIN_DECLARATION_TIMESTAMP`.
3. Call the search service directly (`POST /api/v1/search` with the declaration's ISCC
   — see the contract doc) to distinguish "item not indexed" from "join broken".
4. If the vector exists but the hit vanishes from results, look up its `primary_key` in
   `vectorToDataMap` — a missing row means the mapping write failed (re-ingest fixes it).

### Search service outage

Ingest keeps working: index events queue up on the Kinesis index stream and the search service
catches up when it recovers (its consumer retries; Kinesis retains records for the stream's
retention window, 24 h by default — a longer outage needs a replay per the contract doc §4).
Only the interactive search endpoints are affected (5xx) during the outage. If the *stream
itself* is missing (search app not deployed for this stage), the ingest pipeline fails at the
emit step and declarations go `failed` — deploy the search app or set
`SEARCH_INDEX_STREAM_NAME` to `_`.

### Slack notifications stopped

- Webhook revoked? Update `SECRET_SLACK_WEBHOOK_URL` and redeploy the stage.
- On `dev` stage they are suppressed by design.
- Check `SlackRateLimit` table entries — a stuck window can block a company's notifications
  (delete the row for that key to reset).

### `<key> is not bound` runtime error

A handler reads a `Config.*`/`Table.*` that isn't in its `bind` list. Add the binding in
`stacks/CommonsDBStack.ts` and redeploy (see configuration.md, "Binding map").

## Routine tasks

| Task | How |
|---|---|
| Rotate the search-service key | Generate a new key → set it in the search service → `sst secret set SECRET_SEARCH_SERVICE_API_KEY … --stage <s>` → redeploy this stage |
| Rotate a Zuplo internal key | Update the gateway config and the SST secret together, then redeploy |
| Redact content | `POST /api/v1/redact` (see api.md) — or `scripts/redact.sh` for bulk |
| Force analytics recount | `POST /api/v1/recalculateAnalytics` (or wait for the 48 h cron) |
| Registry reconciliation | `pnpm backfill:iroh-registry` / `pnpm verify:iroh-registry` |
| Inspect a raw declaration | Find the S3 path via `vectorToDataMap` or `IdentifiersOfDeclaration`, then fetch the object (bucket `<stage>-commonsdb-declaration-data`) |

## Data safety notes

- **S3 is the source of truth** and versioned; DynamoDB rows and vectors are derived and can be
  rebuilt (vectors: see search-service-contract.md §6).
- Redaction never deletes data — it flags it. Actual deletion would be a manual S3+DynamoDB
  operation (no tooling provided).
- Back up DynamoDB via PITR (enable per table in AWS console; not currently codified) if the
  rebuild-from-S3 window is unacceptable.
