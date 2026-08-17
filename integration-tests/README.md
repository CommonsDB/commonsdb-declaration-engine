# CommonsDB Integration Tests

HTTP integration-test harness for a **deployed** CommonsDB gateway. It exercises
the public API surface (ingest, search, metadata, status) end-to-end against a
running stage — including real ES256 JWT signing and RFC 3161 TSA timestamping.

Unlike the unit tests in `packages/*` (which run offline via Vitest), these
tests require a live endpoint and credentials, so they are **not** part of CI.

## What's here

```
integration-tests/
├── src/
│   ├── setup.ts              # Jest setup, .env loading
│   ├── fixtures/
│   │   └── testData.ts       # Declaration metadata generators
│   ├── utils/
│   │   ├── testConfig.ts     # Env/config + key loading, JWK export
│   │   ├── apiClient.ts      # ApiClient + JWT/TSA signing helpers
│   │   └── testHelpers.ts    # Payload builders / assertions
│   └── tests/
│       └── smoke.test.ts     # Live smoke test (skipped without API_BASE_URL)
├── jest.config.js
├── tsconfig.json
└── package.json
```

`smoke.test.ts` is the reference example. The signing/client scaffolding in
`utils/` and `fixtures/` is designed to be extended with additional suites
(e.g. `ingest.test.ts`, `search.test.ts`) that follow the same pattern.

## Prerequisites

1. Node.js 20+
2. An EC (P-256 / `prime256v1`) keypair for signing
3. A deployed CommonsDB gateway URL and, if required, an API key

## Setup

```bash
cd integration-tests
npm install

# create your .env from the template
npm run setup            # copies env.template -> .env
```

Edit `.env`:

```env
API_BASE_URL=https://your-gateway-url
API_KEY=your-api-key            # optional, if the gateway requires it
DECLARER_ID=did:key:your-declarer-id
COMPANY_ID=did:key:your-company-id
EC_PRIVATE_KEY_PATH=./api_test_ec_private_key.pem
EC_PUBLIC_KEY_PATH=./api_test_ec_public_key.pem
TSA_URL=https://freetsa.org/tsr
ISCC_CODE=ISCC:your-iscc-code
```

Generate a signing keypair in this folder:

```bash
npm run generate-keys
```

## Running

```bash
npm test              # runs all *.test.ts (serially)
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

With no `API_BASE_URL` set, the live suites skip themselves and the run passes —
handy for verifying the harness compiles without a deployment.

## Writing a new suite

Build a payload with the signing helpers, submit it through `ApiClient`, and
assert on the structured `ApiResponse`:

```typescript
import { ApiClient } from "../utils/apiClient";
import { getTestConfig } from "../utils/testConfig";

const client = new ApiClient(getTestConfig());

it("rejects a declaration with a missing name", async () => {
  const res = await client.submitDeclaration(/* ...invalid payload... */);
  expect(res.success).toBe(false);
  expect(res.statusCode).toBe(400);
}, 30000);
```

## Notes

- Tests run serially (`--runInBand`) and the TSA client is rate-limited via an
  internal semaphore to stay within free TSA service limits.
- Default `testTimeout` is 120s to accommodate TSA round-trips.
