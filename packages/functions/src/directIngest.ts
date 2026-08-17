/**
 * Direct Ingest endpoint — POST /api/v1/direct-ingest
 *
 * A Zuplo-free ingest path for declarers registered in DynamoDB.
 * This handler only performs the extra auth checks; once those pass it
 * forwards to the original `ingest` handler unchanged.
 *
 * Auth flow (replaces SECRET_ZUPLO_ACCESS_KEY check):
 *   1. Parse body → extract publicMetadata.declarerId (the did:key).
 *   2. Look up the DirectIngestRegistration for that declarerId.
 *   3. SHA-256 hash the incoming x-api-key and compare with stored hash.
 *   4. Extract the JWK embedded in the JWT (signature field) and verify it
 *      matches the public key stored for this declarerId.
 *   5. Optional: reject if the caller IP is not on the registration's allowedIps.
 *
 * After all checks pass the event headers are patched so the original `ingest`
 * handler sees the headers it expects (x-api-key, x-declarer-id, x-company-id)
 * and the call is forwarded directly — no logic is duplicated.
 */
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import * as jwt from "jsonwebtoken";
import { getDirectIngestRegistration, hashApiKey, jwksMatch } from "@commonsdb/core/searchUtils/directIngestUtil";
import { ingest } from "./ingest";

export const directIngest = ApiHandler(async (_evt) => {
  if (_evt.requestContext.http.method !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // ── 1. Parse body (read-only — we pass the raw body to ingest untouched) ──
  let data: Record<string, unknown> | undefined;
  try {
    data = _evt.body ? JSON.parse(_evt.body) : undefined;
  } catch {
    return { statusCode: 400, body: "Invalid request body" };
  }
  if (!data) {
    return { statusCode: 400, body: "Invalid request body" };
  }

  // ── 2. Resolve declarerId from body ───────────────────────────────────────
  const declarerId = (
    (data.declarationMetadata as Record<string, unknown> | undefined)?.publicMetadata as
      Record<string, unknown> | undefined
  )?.declarerId as string | undefined;

  if (!declarerId) {
    return {
      statusCode: 422,
      body: JSON.stringify({
        error: "Missing declarerId",
        message: "publicMetadata.declarerId is required for direct ingest",
      }),
    };
  }

  // ── 3. Require API key header ─────────────────────────────────────────────
  const incomingApiKey = _evt.headers["x-api-key"];
  if (!incomingApiKey) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  // ── 4. Look up DynamoDB registration ─────────────────────────────────────
  let registration;
  try {
    registration = await getDirectIngestRegistration(declarerId);
  } catch (err: unknown) {
    console.error("[DirectIngest] DynamoDB lookup error:", err);
    return { statusCode: 500, body: "Internal error during authentication" };
  }

  if (!registration || !registration.isActive) {
    console.warn(`[DirectIngest] No active registration for declarerId: ${declarerId}`);
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: "Unauthorized",
        message: "No active direct-ingest registration for this declarerId",
      }),
    };
  }

  // ── 5. Verify API key hash ────────────────────────────────────────────────
  if (hashApiKey(incomingApiKey) !== registration.apiKeyHash) {
    console.warn(`[DirectIngest] API key mismatch for declarerId: ${declarerId}`);
    return { statusCode: 401, body: "Unauthorized" };
  }

  // ── 6. Optional IP allowlist check ───────────────────────────────────────
  if (registration.allowedIps) {
    const allowedList = registration.allowedIps
      .split(",")
      .map((ip: string) => ip.trim())
      .filter(Boolean);

    if (allowedList.length > 0) {
      const callerIp =
        (_evt.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || _evt.requestContext.http.sourceIp;

      if (!allowedList.includes(callerIp)) {
        console.warn(`[DirectIngest] IP ${callerIp} not in allowlist for declarerId: ${declarerId}`);
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

  // ── 7. Verify the embedded JWK matches the registered public key ──────────
  const signature = data.signature as string | undefined;
  if (!signature) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing signature", message: "signature field is required" }),
    };
  }

  const decoded = jwt.decode(signature, { complete: true });
  const embeddedJwk = (decoded?.header as Record<string, unknown> | undefined)?.jwk as
    Record<string, unknown> | undefined;

  if (!embeddedJwk) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Invalid signature",
        message: "JWT signature must include a JWK in its header for direct ingest",
      }),
    };
  }

  let registeredJwk: Record<string, unknown>;
  try {
    registeredJwk = JSON.parse(registration.publicKeyJwk);
  } catch {
    console.error("[DirectIngest] Stored publicKeyJwk is malformed for declarerId:", declarerId);
    return { statusCode: 500, body: "Internal error: malformed registration" };
  }

  if (!jwksMatch(embeddedJwk, registeredJwk)) {
    console.error(
      `[DirectIngest] JWK mismatch for declarerId: ${declarerId}`,
      "embedded:",
      embeddedJwk,
      "registered:",
      registeredJwk,
    );
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: "Key mismatch",
        message: "The JWK embedded in the JWT does not match the public key registered for this declarerId",
      }),
    };
  }

  console.log(`[DirectIngest] Auth passed for declarerId: ${declarerId} — forwarding to ingest`);

  // ── 8. Forward to the original ingest handler ─────────────────────────────
  //
  // Patch the headers the ingest handler expects:
  //   • x-api-key      — must equal SECRET_ZUPLO_ACCESS_KEY (ingest's own check)
  //   • x-declarer-id  — normally injected by Zuplo; we set it from the DB lookup
  //   • x-company-id   — used for the PEM fallback map; use declarerId (did:key)
  //
  // Everything else (body, requestContext, …) is passed through unchanged.
  const patchedEvt = {
    ..._evt,
    headers: {
      ..._evt.headers,
      "x-api-key": Config.SECRET_ZUPLO_ACCESS_KEY,
      "x-declarer-id": declarerId,
      "x-company-id": declarerId,
    },
  };

  // Call the wrapped Lambda handler directly.  SST's ApiHandler just passes the
  // event through to the underlying async function, so this works as a normal
  // async call.  `as any` avoids fighting the opaque ApiHandler wrapper type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ingest as any)(patchedEvt);
});
