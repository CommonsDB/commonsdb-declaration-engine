# HTTP API reference

Three API Gateway HTTP APIs are deployed (base URLs are stack outputs). All routes are versioned
under `/api/v1` except the customer-keys API.

**Authentication.** Unless stated otherwise a route requires the header
`x-api-key: <SECRET_ZUPLO_ACCESS_KEY>` and returns `401 Unauthorized` on mismatch. Two routes use
the secondary key (`SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B`), noted below. In the production
topology these internal keys are injected by the fronting API gateway (Zuplo), which performs
customer-facing auth; when calling AWS URLs directly you must supply them yourself.

**Identifier parameter.** Routes documented with `?<identifier>=` use the *dynamic identifier
field name* configured by `SECRET_IDENTIFIER_FIELD_KEY_NAME` (in practice `cidV1`) — i.e. the
actual query parameter is `?cidV1=<value>`. See
[architecture.md §3.3](architecture.md#33-the-dynamic-identifier-field).

---

## Ingest API (`API_ingestApi`)

### `POST /api/v1/ingest`

Submit a declaration. Headers: `x-api-key` (primary), `x-declarer-id` (declarer DID; injected by
the gateway). Body: a declaration document conforming to the v0.2.0 JSON Schema
(`schemas/`). Core structure:

```jsonc
{
  "signature": "<ES256 JWT with embedded JWK>",       // signs the core declaration data
  "tsaSignature": { "tsr": "<b64>", "tsq": "<b64>" }, // RFC 3161 timestamp response/query
  "declarationMetadata": {
    "publicMetadata": {
      "$schema": "https://w3id.org/commonsdb/schema/0.2.0.json",
      "@context": "…",
      "iscc": "ISCC:…",
      "declarerId": "did:key:…",
      "timestamp": 1736380800000,                         // Unix-milliseconds number
      "name": "…", "description": "…", "mediatype": "…", // …full field list in schemas/
      "entryUUID": "…"
    },
    "optOutMetadata": { /* optional */ },
    "commonsDbRegistry": { /* optional */ }
  },
  "supersedes": "<identifier of a previous declaration>"   // optional
}
```

Validation performed synchronously (any failure → `4xx` with an error list):

1. A custom JSON-Schema validator (`validateAgainstJsonSchema`); `$schema`/`@context` URLs must
   match `https://w3id.org/commonsdb/schema/<v>.json`.
2. `signature` JWT verifies (ES256) against its embedded JWK, and the signed content matches
   `publicMetadata`.
3. `tsaSignature` parses as RFC 3161 TSQ/TSR and its content matches.
4. `publicMetadata.timestamp` (a Unix-milliseconds number) is within **60 seconds** of server
   time (`isTimestampWithin60Seconds`).

On success: `DeclarationStatus` is set to `pending`, the record is queued to Kinesis, and the
response returns the assigned identifier(s). Indexing completes asynchronously — poll
`getDeclarationStatus`.

### `POST /api/v1/direct-ingest`

Gateway-free ingest for pre-registered declarers. Headers: `x-declarer-id: <did:key>`,
`x-api-key: <declarer-specific key>`. The handler resolves the declarer in the
`directIngestRegistrations` table, compares `SHA-256(x-api-key)` with the stored hash, checks the
declarer's JWK, then forwards internally to the same logic as `/ingest`. Body: identical to
`/ingest`.

### `GET /api/v1/direct-status?<identifier>=<value>`

Status polling for direct-ingest declarers; same per-declarer auth as `direct-ingest`, then
forwards to the status lookup below.

---

## Search & data API (`API_searchApi`)

### Similarity search

| Route | Auth key | Query | Description |
|---|---|---|---|
| `GET /api/v1/search` | primary (rejects requests that carry an `x-company-id` header) | `iscc` (required) | Full similarity search: ISCC → external search service (score < 4) → hydrate from S3 → redaction/denylist/timestamp filtering → censored results |
| `GET /api/v1/search-iscc` | **secondary** (`…_SEARCH_B2B`) | `iscc` | Same pipeline with a wider cutoff (score < 16), B2B response variant |
| `GET /api/v1/searchDeclarer` | primary | `iscc` (only) | Same pipeline with a wider cutoff (score < 16); applies the global `DECLARER_ID_DENYLIST` filter — it does **not** filter by a specific declarer |

Response shape of `/search` (`200`):

```jsonc
{
  "q": "ISCC:…",
  "hashBits": "1001…",          // content representation resolved by the search service
  "invalidCount": 0,
  "version": "1.0.0",
  "results": [
    {
      "s3Path": "s3://…", "s3MapItemId": "<itemId>", "score": 4,     // score = similarity distance (0 = identical)
      "docBody": {
        "metaInternal": { "rayId": "…", "cid": "…", "cidV1": "…", "declarationId": "…",
                           "isccCode": "ISCC:…", "hammingDistance": 4 },
        "declarationMetadata": { "publicMetadata": { /* full public metadata */ },
                                  "commonsDbRegistry": { /* if present */ } }
      }
    }
  ]
}
```

Private metadata is stripped; redacted declarations/products, denylisted declarers, and
declarations older than `MIN_DECLARATION_TIMESTAMP` are filtered out.

### Exact lookup

| Route | Query | Returns |
|---|---|---|
| `GET /api/v1/getByDecId` | `<identifier>` | Public metadata for one declaration (`404` if unknown) |
| `GET /api/v1/getByIdentifier` | `<identifier>` | Same lookup, alternate route |
| `GET /api/v1/getByCid` | `cid` | Lookup via the legacy CIDs table |
| `GET /api/v1/getFullById` | `cid` | Full metadata (superset) by identifier |
| `GET /api/v1/getDeclarationStatus` | `<identifier>` | `{ status: "pending" \| "success" \| "failed", message, createdAt, updatedAt }` |

### Browsing & counts

| Route | Description |
|---|---|
| `GET /api/v1/latest` | Most recent declarations (via the `vectorToDataMap` timestamp GSI) |
| `GET /api/v1/random` | Random declarations (excludes `RANDOM_DECLARER_ID_DENYLIST`) |
| `GET /api/v1/fullCount` | Total number of declarations |
| `GET /api/v1/uniqueIsccCount` | Number of distinct ISCC codes (60 s timeout) |

### Redaction

`POST /api/v1/redact` — body:

```jsonc
{
  "identifier": "…",        // or "identifiers": ["…", …]   ── identifier scope
  "productId": "…",         // or "productIds": ["…", …]     ── product scope
  "customerId": "…",        // customer scope
  "isRedacted": true          // true = redact, false = un-redact
}
```

Exactly **one** scope must be supplied — identifier(s) **or** product id(s) **or** `customerId`;
they are mutually exclusive and providing more than one returns `400`. Sets redaction flags
checked at read time (data is never deleted). Identifier redactions are mirrored to the external
iroh registry (best-effort). `declarationId` is accepted as a deprecated alias for `identifier`.

### Statistics & analytics

| Route | Auth | Description |
|---|---|---|
| `GET /api/v1/statistics` | primary **or** secondary key | Aggregated statistics from the `cdb_stats` Postgres (trigger-maintained stats tables) |
| `GET /api/v1/analyticsStatus` | primary | State of the analytics counters |
| `POST /api/v1/setupAnalytics` | primary | Initialize analytics counters (long-running, 15 min timeout) |
| `POST /api/v1/recalculateAnalytics` | primary | Force full analytics recount (15 min timeout) |
| `POST /api/v1/cleanupStalePending` | primary | Manually run the stale-pending cleanup |

### Utilities

| Route | Query | Description |
|---|---|---|
| `GET /api/v1/generateIsccFromUrl` | `srcUrl` | Generates an ISCC code for the media at `srcUrl` (via the configured `iscc-web` service at `ISCC_HOST`) |

---

## Customer keys API (`API_customerKeysApi`)

Manages per-customer signing keys, stored encrypted (symmetric `SECRET_ENCRYPTION_KEY`) in the
`customerKeys` table. Auth: `x-api-key` (primary key).

| Route | Description |
|---|---|
| `POST /generateKey` | Creates a key pair for the `customerId` in the JSON body if missing; returns the public part |
| `GET /getDecryptedKey` | Returns the decrypted private key for the `customerId` given in the `x-customer-id` header — treat access to this API as highly privileged |

---

## Error conventions

| Status | Meaning |
|---|---|
| `400` | Missing/invalid parameter or body (message names the field) |
| `401` | Missing or wrong `x-api-key` |
| `404` | Identifier/CID not found |
| `405` | Wrong HTTP method |
| `5xx` | Downstream failure (DynamoDB, S3, search service, ISCC host) — safe to retry idempotent GETs |
