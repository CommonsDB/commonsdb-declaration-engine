# Search Service — integration contract

Similarity search is delegated to an external **search service**, deployed and operated
separately (a sibling AWS deployment); its source is not part of this repository. This document
is the contract the registry codes against. The service is a black box: the registry exchanges
**ISCC codes**, **opaque item ids**, and **similarity scores** with it — no storage or algorithm
details leak into this codebase.

There are two integration channels:

| Channel | Direction | Purpose | Registry module |
|---|---|---|---|
| **Kinesis index stream** | registry → service (fire-and-forget) | Add declarations to the similarity index during ingest | `packages/core/src/searchUtils/searchIndexProducer.ts` |
| **HTTPS query API** | registry → service (request/response) | Interactive similarity queries | `packages/core/src/searchUtils/searchServiceClient.ts` |

## 1. Index stream (Kinesis)

- **Stream**: an AWS Kinesis stream with the physical name
  `<stage>-commonsdb-serverless-search`, provisioned **by the search service's** deployment.
  The registry addresses it by name (`SEARCH_INDEX_STREAM_NAME` parameter, `"_"` disables
  emission) and grants its declaration processor `kinesis:PutRecord` on that ARN.
- **Record** (JSON, UTF-8; partition key = `itemId`):

```json
{
  "itemId": "5f0c…-…",            // minted by the REGISTRY (UUID)
  "iscc": "ISCC:KEC6SQBQRPU4GKGD…",
  "rayId": "…",                    // optional, tracing
  "timestamp": 1737543212345       // emit time, Unix ms
}
```

- **Semantics**:
  - The registry mints the `itemId`, persists it in `vectorToDataMap` **before** searchability,
    and emits the event. There is no response channel.
  - The service MUST index the ISCC under exactly the provided `itemId` and MUST be
    **idempotent** on redelivery (Kinesis retries can deliver the same event more than once —
    re-indexing the same `itemId` must not create duplicates).
  - Events with unresolvable ISCCs are retried service-side and eventually dropped by its
    retry policy; the registry is not notified (see §4 for reconciliation).
  - Ordering across different `itemId`s does not matter.
- **Failure semantics on the registry side**: a failed `PutRecord` propagates and the
  declaration record is retried by the registry's own ingest queue. After a successful put the
  registry considers indexing handed off; searchability lags by the stream + consumer latency
  (normally seconds).

## 2. Query API (HTTPS)

- **Base URL**: `SEARCH_SERVICE_URL` parameter (no trailing slash).
- **Authentication**: `x-api-key: <shared key>`; the registry stores the same value as
  `SECRET_SEARCH_SERVICE_API_KEY`. Mismatch → `401`.

### 2.1 `POST /api/v1/search`

Request:

```json
{ "iscc": "ISCC:KEC6SQBQRPU4GKGD…" }
```

Success — `200`:

```json
{
  "hashBits": "1001…",
  "results": [
    { "itemId": "5f0c…", "score": 0 },
    { "itemId": "77aa…", "score": 4 }
  ]
}
```

Requirements:

- `results` MUST be an array of `{ itemId, score }`:
  - `itemId` — string, the id the registry supplied when the item was indexed;
  - `score` — number: similarity distance, `0` = identical content, larger = less similar.
    For interoperability with existing data, the score MUST equal the Hamming distance (0–64)
    between the 64-bit ISCC content-hash codes of the query and the stored item.
- Return up to **100** nearest items. Ordering need not be sorted (the registry sorts), but the
  set must contain the true nearest neighbours.
- Do **not** filter by relevance server-side — the registry applies its own per-endpoint
  cutoffs (currently `score < 4` for `/search`, `score < 16` for `/search-iscc` and
  `/searchDeclarer`).
- `hashBits` is the service-resolved content representation of the queried ISCC (a
  64-character `0`/`1` string); the registry echoes it in its public responses.
- An empty index returns `{ "hashBits": "…", "results": [] }` with `200`.

Errors: `400` missing `iscc`, `422` unresolvable ISCC, `401` bad key, `5xx` backend failure.

### 2.2 `GET /api/v1/health`

Liveness probe returning `200` with any JSON body. Used by deployment smoke tests and monitors.

## 3. Non-functional expectations

| Aspect | Expectation |
|---|---|
| Query latency | `POST /search` sits on the interactive path of the registry's `GET /search`; p95 under ~500 ms is comfortable. |
| Index latency | Searchability within seconds of the event landing on the stream. |
| Durability | Item ids are referenced forever from `vectorToDataMap`. Losing index entries silently breaks search hits for those declarations (the declarations themselves stay safe in S3/DynamoDB; see §4). |
| Idempotency | Required on the index path (Kinesis redelivery). On the registry side, a declaration retry after a successful emit mints a *new* itemId — the older orphan id is harmless (no `vectorToDataMap` row wins; the stale row is overwritten). |

## 4. Rebuilding / reconciling the index

The similarity index is derived data. If it is lost, or events were dropped:

1. Enumerate all declarations (S3 bucket listing, or the `vectorToDataMap` GSI).
2. For each: read its ISCC and its `itemId` from `vectorToDataMap` → emit an index event with
   that same `itemId` onto the stream (idempotent on the service side).
3. For a full migration to a fresh index, the same replay works unchanged — ids are preserved.

There is no ready-made script for this in the repository; the backfill scripts in `scripts/`
are the closest template.

## 5. Conformance checklist for a new implementation

- [ ] consumes `<stage>-commonsdb-serverless-search`; indexes under the **provided** `itemId`
- [ ] idempotent on event redelivery (no duplicates for the same `itemId`)
- [ ] partial-batch failure handling with retries; malformed records dropped, not poison-pilled
- [ ] `x-api-key` enforced on the query API; 401 otherwise
- [ ] `search` returns ≤ 100 rows as `{ hashBits, results: [{ itemId, score }] }`, unfiltered
- [ ] `score` = Hamming distance (0–64) between the items' 64-bit ISCC content-hash codes
- [ ] `422` for unresolvable query ISCCs; empty index → `results: []`, 200
