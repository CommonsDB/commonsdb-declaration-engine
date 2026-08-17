/**
 * Smoke test for a deployed CommonsDB gateway.
 *
 * These tests hit a live HTTP endpoint, so they are skipped unless
 * `API_BASE_URL` is set (via `.env` — see the README). This keeps the suite
 * safe to run in CI or on a fresh clone without a deployment.
 *
 * Use this as the template for further integration tests: build a payload with
 * the signing helpers in `../utils/apiClient`, submit it through `ApiClient`,
 * and assert on the structured `ApiResponse`.
 */
import { ApiClient } from "../utils/apiClient";
import { getTestConfig } from "../utils/testConfig";

const hasEndpoint = Boolean(process.env.API_BASE_URL);
const describeIfLive = hasEndpoint ? describe : describe.skip;

if (!hasEndpoint) {
  // eslint-disable-next-line no-console
  console.warn("[smoke] API_BASE_URL not set — skipping live integration smoke tests.");
}

describeIfLive("CommonsDB gateway smoke tests", () => {
  let client: ApiClient;

  beforeAll(() => {
    client = new ApiClient(getTestConfig());
  });

  it("returns a response from the latest endpoint", async () => {
    const res = await client.getLatest(1);
    expect(res.statusCode).toBeDefined();
    // A healthy gateway answers with 200 (data) or 401 (auth required),
    // never a transport-level failure.
    expect([200, 401, 403]).toContain(res.statusCode);
  });

  it("rejects an obviously invalid declaration with a 4xx", async () => {
    const res = await client.submitDeclaration({ not: "a valid declaration" });
    expect(res.success).toBe(false);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
