# commonsdb-serverless

[![CI](https://github.com/yurykharytanovich/commonsdb-serverless/actions/workflows/ci.yml/badge.svg)](https://github.com/yurykharytanovich/commonsdb-serverless/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20-brightgreen.svg)](.nvmrc)

Serverless backend of the **CommonsDB declaration registry** — a public, verifiable registry of
content declarations for digital media.

Publishers and rights-holders submit cryptographically signed content declarations. Each
declaration binds together:

- an **ISCC** ([International Standard Content Code](https://iscc.codes), ISO 24138) — a
  similarity-preserving content fingerprint,
- a **DID** ([Decentralized Identifier](https://www.w3.org/TR/did-core/), `did:key`) — the
  declarer's cryptographic identity,
- an **RFC 3161 TSA timestamp** — third-party proof of existence at declaration time,
- structured **JSON-LD metadata** (CommonsDB schema, v0.2.0).

The system validates submissions (JSON Schema, JWT signature, TSA timestamp), indexes them into
DynamoDB and S3 through a Kinesis pipeline, and exposes HTTP APIs for ingest, exact lookup, and
**similarity search** over ISCC content hashes.

## High-level architecture

```
                 ┌─────────────────────────────  AWS (SST v2 / CloudFormation)  ─────┐
                 │                                                                   │
 POST /ingest ──►│ ingest λ ──► Kinesis ──► declarationProcessor λ ──► S3 (raw JSON) │
                 │  (validate)   stream        (indexing pipeline)  ──► DynamoDB     │
                 │                                   │                               │
                 │                                   ▼ index event { itemId, iscc }  │
                 │                        Kinesis: <stage>-commonsdb-serverless-search
                 │                        ╔══════════▼═══════════════╗              │
 GET /search ───►│ search λ ── HTTPS ────►║      Search Service      ║              │
                 │  (hydrate from S3 /    ║  (separate deployment,   ║              │
                 │   DynamoDB, redact,    ║  see docs/search-service-║              │
                 │   filter, censor)      ║  contract.md)            ║              │
                 │                        ╚══════════════════════════╝              │
                 └───────────────────────────────────────────────────────────────────┘
```

Similarity search is **decomposed into a separate, independently deployed service** that owns the
similarity index. Indexing flows through the service's **Kinesis index stream** (fire-and-forget
from the ingest pipeline); interactive queries use its authenticated **HTTPS API**. This
repository is self-sufficient: the complete integration contract is specified in
[docs/search-service-contract.md](docs/search-service-contract.md), so any conforming
implementation can be plugged in via three config values (`SEARCH_INDEX_STREAM_NAME`,
`SEARCH_SERVICE_URL`, `SECRET_SEARCH_SERVICE_API_KEY`).

## Tech stack

| Layer | Technology |
|---|---|
| IaC / deployment | [SST v2](https://v2.sst.dev) (~2.40) on AWS CDK |
| Runtime | Node.js 20, TypeScript 5.4+, ES modules |
| Package manager | pnpm (workspaces) |
| API | AWS API Gateway v2 (HTTP APIs) |
| Compute | AWS Lambda |
| Ingest queue | AWS Kinesis (partial batch failure semantics) |
| Storage | DynamoDB (11 tables) + S3 (versioned bucket) |
| Similarity search | External search service: Kinesis index stream (writes) + HTTPS query API (contract in docs) |
| Scheduler | AWS EventBridge (crons + custom bus) |
| ISCC generation | ECS Fargate service running [`iscc-web`](https://github.com/iscc/iscc-web) |
| Statistics | PostgreSQL (`cdb_stats`, populated live + by external batch pipeline) |
| Testing | Vitest (unit), Jest (HTTP integration tests) |

## Repository layout

```
├── sst.config.ts                  # SST entry point (app name + region)
├── stacks/
│   ├── CommonsDBStack.ts          # Main stack: APIs, Lambdas, tables, Kinesis, crons
│   └── ISCCStack.ts               # ECS Fargate service running iscc-web
├── packages/
│   ├── core/                      # @commonsdb/core — shared domain logic
│   │   └── src/
│   │       ├── interfaces/        # Canonical TypeScript types (commonInterfaces.ts)
│   │       ├── utils/             # Declaration parsing, TSA crypto, field mapping
│   │       ├── searchUtils/       # Indexing pipeline, DynamoDB/S3 helpers, search client
│   │       ├── statistics/        # cdb_stats Postgres sync + queries
│   │       ├── producer/          # Kinesis producer
│   │       └── customer-keys/     # Customer key encryption
│   └── functions/                 # @commonsdb/functions — all Lambda handlers
│       └── src/                   # One file per route + cron/ subfolder
├── schemas/                       # JSON-LD declaration example + schema docs (v0.2.0)
├── integration-tests/             # Jest HTTP tests (run against staging only)
├── scripts/                       # Registry backfill / verification scripts
└── docs/                          # ← start here
```

## Documentation

| Document | Contents |
|---|---|
| [docs/setup.md](docs/setup.md) | From-zero setup: prerequisites, AWS, secrets, first deploy, stage bootstrap |
| [docs/architecture.md](docs/architecture.md) | Components, data model, ingest pipeline, search flow, event flows |
| [docs/api.md](docs/api.md) | Full HTTP API reference (ingest, search/lookup, status, redaction, statistics) |
| [docs/search-service-contract.md](docs/search-service-contract.md) | Integration contract of the external search service (Kinesis + HTTPS) |
| [docs/configuration.md](docs/configuration.md) | Every secret and parameter: purpose, consumers, how to set |
| [docs/development.md](docs/development.md) | Local dev workflow, tests, conventions, deployment |
| [docs/operations.md](docs/operations.md) | Monitoring, alerting, known gaps, troubleshooting runbook |
| [docs/analytics-system.md](docs/analytics-system.md) | Analytics counters subsystem |

## Quickstart (development)

```bash
# prerequisites: Node 20+, pnpm, AWS credentials configured (see docs/setup.md)
pnpm install
pnpm typecheck

# live-Lambda development against the staging stage
pnpm dev:stag
```

A full deployment requires secrets and a running search service — follow
[docs/setup.md](docs/setup.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
