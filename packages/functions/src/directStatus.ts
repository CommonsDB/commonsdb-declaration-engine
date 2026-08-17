/**
 * Direct Status endpoint — GET /api/v1/direct-status
 *
 * A Zuplo-free status path for declarers registered in DynamoDB.
 * Mirrors the auth model of directIngest: x-api-key hash check against the
 * directIngestRegistrations table, then forwards to the original
 * getDeclarationStatus handler unchanged.
 *
 * Auth flow:
 *   1. Require x-declarer-id header (the did:key; client always knows their own).
 *   2. Look up the DirectIngestRegistration for that declarerId.
 *   3. SHA-256 hash the incoming x-api-key and compare with stored hash.
 *   4. Forward — patch x-api-key to SECRET_ZUPLO_ACCESS_KEY so the downstream
 *      handler passes its own key check.
 */
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { getDirectIngestRegistration, hashApiKey } from "@commonsdb/core/searchUtils/directIngestUtil";
import { getDeclarationStatus } from "./getDeclarationStatus";

export const directStatus = ApiHandler(async (_evt) => {
  if (_evt.requestContext.http.method !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // ── 1. Require x-declarer-id header ──────────────────────────────────────
  const declarerId = _evt.headers["x-declarer-id"];
  if (!declarerId) {
    return {
      statusCode: 422,
      body: JSON.stringify({
        error: "Missing x-declarer-id",
        message: "x-declarer-id header is required for direct status",
      }),
    };
  }

  // ── 2. Require x-api-key header ──────────────────────────────────────────
  const incomingApiKey = _evt.headers["x-api-key"];
  if (!incomingApiKey) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // ── 3. Look up DynamoDB registration ─────────────────────────────────────
  let registration;
  try {
    registration = await getDirectIngestRegistration(declarerId);
  } catch (err: unknown) {
    console.error("[DirectStatus] DynamoDB lookup error:", err);
    return { statusCode: 500, body: "Internal error during authentication" };
  }

  if (!registration || !registration.isActive) {
    console.warn(`[DirectStatus] No active registration for declarerId: ${declarerId}`);
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: "Unauthorized",
        message: "No active direct-ingest registration for this declarerId",
      }),
    };
  }

  // ── 4. Verify API key hash ────────────────────────────────────────────────
  if (hashApiKey(incomingApiKey) !== registration.apiKeyHash) {
    console.warn(`[DirectStatus] API key mismatch for declarerId: ${declarerId}`);
    return { statusCode: 401, body: "Unauthorized" };
  }

  // ── 5. Optional IP allowlist check ───────────────────────────────────────
  if (registration.allowedIps) {
    const allowedList = registration.allowedIps
      .split(",")
      .map((ip: string) => ip.trim())
      .filter(Boolean);

    if (allowedList.length > 0) {
      const callerIp =
        (_evt.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || _evt.requestContext.http.sourceIp;

      if (!allowedList.includes(callerIp)) {
        console.warn(`[DirectStatus] IP ${callerIp} not in allowlist for declarerId: ${declarerId}`);
        return {
          statusCode: 403,
          body: JSON.stringify({
            error: "Forbidden",
            message: "Caller IP address is not permitted for this registration",
          }),
        };
      }
    }
  }

  console.log(`[DirectStatus] Auth passed for declarerId: ${declarerId} — forwarding to getDeclarationStatus`);

  // ── 6. Forward to the original status handler ─────────────────────────────
  const patchedEvt = {
    ..._evt,
    headers: {
      ..._evt.headers,
      "x-api-key": Config.SECRET_ZUPLO_ACCESS_KEY,
      "x-declarer-id": declarerId,
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getDeclarationStatus as any)(patchedEvt);
});
