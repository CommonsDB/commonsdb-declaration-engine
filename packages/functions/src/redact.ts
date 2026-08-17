import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
// import
import {
  writeRedactedMappingToDB,
  writeRedactedMappingsToDB,
  writeRedactedProductMappingToDB,
  writeRedactedProductMappingsToDB,
} from "@commonsdb/core/searchUtils/tableRedactedUtil";
import { sendIrohRegistryRedactions } from "@commonsdb/core/searchUtils/irohRegistryUtil";

// Propagate a redaction change to the iroh registry (best-effort). The
// registry only knows identifier-scoped records, so productId/customerId
// scopes are not forwarded. A failure here must not fail the redact call:
// the Redacted table stays the source of truth and the registry backfill
// script skips/reconciles redacted identifiers on its next run.
async function mirrorRedactionsToIrohRegistry(identifiers: string[], isRedacted: boolean): Promise<void> {
  try {
    await sendIrohRegistryRedactions(identifiers, isRedacted);
  } catch (error) {
    console.error("Error mirroring redactions to iroh registry (non-blocking):", error);
  }
}

interface IRedactPayload {
  /** @deprecated Use identifier or identifiers instead */
  declarationId?: string;
  /** The dynamic identifier (cidV1) to redact - single value */
  identifier?: string;
  /** Array of dynamic identifiers (cidV1) to redact */
  identifiers?: string[];
  /** Single productId to redact */
  productId?: string;
  /** Array of productIds to redact */
  productIds?: string[];
  customerId?: string;
  isRedacted: boolean;
}
export const redact = ApiHandler(async (_evt) => {
  if (_evt.requestContext.http.method !== "POST") {
    return {
      statusCode: 405,
      body: "Method not allowed",
    };
  }

  // check for key in headers 						SECRET_ZUPLO_ACCESS_KEY,
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }
  // get json data from event body
  const bod = await _evt.body;
  const data: IRedactPayload | undefined = bod ? JSON.parse(bod) : undefined;
  if (!data) {
    return {
      statusCode: 400,
      body: "Invalid request body",
    };
  }
  // Support both identifier (new) and declarationId (deprecated) for backward compatibility
  const effectiveIdentifier = data.identifier || data.declarationId;

  // Ensure identifiers is an array if provided
  let effectiveIdentifiers: string[] | null = null;
  if (data.identifiers) {
    if (!Array.isArray(data.identifiers)) {
      return {
        statusCode: 400,
        body: "identifiers must be an array of strings",
      };
    }
    effectiveIdentifiers = data.identifiers.filter((id): id is string => typeof id === "string" && id.length > 0);
  } else if (effectiveIdentifier) {
    effectiveIdentifiers = [effectiveIdentifier];
  }

  // Ensure productIds is an array if provided
  let effectiveProductIds: string[] | null = null;
  if (data.productIds) {
    if (!Array.isArray(data.productIds)) {
      return {
        statusCode: 400,
        body: "productIds must be an array of strings",
      };
    }
    effectiveProductIds = data.productIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  } else if (data.productId) {
    effectiveProductIds = [data.productId];
  }

  console.log(
    ">>>Redact request: identifiers:",
    effectiveIdentifiers?.length || 0,
    "productIds:",
    effectiveProductIds?.length || 0,
    "isRedacted:",
    data.isRedacted,
  );

  const definedCount = [effectiveIdentifiers, effectiveProductIds, data.customerId].filter(Boolean).length;
  if (definedCount > 1) {
    return {
      statusCode: 400,
      body: "You can only redact a single scope at a time, you defined more than one",
    };
  }
  if (definedCount === 0) {
    return {
      statusCode: 400,
      body: "You need to define a scope to redact (identifier/identifiers, productId/productIds, or customerId)",
    };
  }

  if (!data || data.isRedacted === undefined) {
    return {
      statusCode: 400,
      body: "Invalid request body (RedactPayload)",
    };
  }

  if (effectiveIdentifiers && effectiveIdentifiers.length > 0) {
    try {
      if (effectiveIdentifiers.length === 1) {
        // Single identifier - use simple put
        await writeRedactedMappingToDB(effectiveIdentifiers[0], data.isRedacted);
        console.log(
          `Successfully wrote redacted mapping to DB for identifier: ${effectiveIdentifiers[0]}, isRedacted: ${data.isRedacted}`,
        );
        await mirrorRedactionsToIrohRegistry(effectiveIdentifiers, data.isRedacted);
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "saved",
            version: Config.VERSION,
            isRedacted: data.isRedacted,
            identifier: effectiveIdentifiers[0],
          }),
        };
      } else {
        // Multiple identifiers - use batch write
        const { success, failed } = await writeRedactedMappingsToDB(effectiveIdentifiers, data.isRedacted);
        console.log(
          `Batch wrote redacted mappings to DB: ${success.length} success, ${failed.length} failed, isRedacted: ${data.isRedacted}`,
        );
        // Only identifiers that actually changed in the Redacted table are
        // mirrored, so the registry cannot drift ahead of the local state.
        await mirrorRedactionsToIrohRegistry(success, data.isRedacted);
        return {
          statusCode: failed.length > 0 ? 207 : 200, // 207 Multi-Status if partial failure
          body: JSON.stringify({
            message: failed.length > 0 ? "partial" : "saved",
            version: Config.VERSION,
            isRedacted: data.isRedacted,
            identifiers: {
              success,
              failed,
              total: effectiveIdentifiers.length,
            },
          }),
        };
      }
    } catch (error) {
      console.error(
        `Error writing redacted mapping to DB for identifiers: ${effectiveIdentifiers}, isRedacted: ${data.isRedacted}`,
        error,
      );
      throw error;
    }
  }

  if (effectiveProductIds && effectiveProductIds.length > 0) {
    try {
      if (effectiveProductIds.length === 1) {
        // Single productId - use simple put
        await writeRedactedProductMappingToDB(effectiveProductIds[0], data.isRedacted);
        console.log(
          `Successfully wrote redacted product mapping to DB for productId: ${effectiveProductIds[0]}, isRedacted: ${data.isRedacted}`,
        );
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "saved",
            version: Config.VERSION,
            isRedacted: data.isRedacted,
            productId: effectiveProductIds[0],
          }),
        };
      } else {
        // Multiple productIds - use batch write
        const { success, failed } = await writeRedactedProductMappingsToDB(effectiveProductIds, data.isRedacted);
        console.log(
          `Batch wrote redacted product mappings to DB: ${success.length} success, ${failed.length} failed, isRedacted: ${data.isRedacted}`,
        );
        return {
          statusCode: failed.length > 0 ? 207 : 200, // 207 Multi-Status if partial failure
          body: JSON.stringify({
            message: failed.length > 0 ? "partial" : "saved",
            version: Config.VERSION,
            isRedacted: data.isRedacted,
            productIds: {
              success,
              failed,
              total: effectiveProductIds.length,
            },
          }),
        };
      }
    } catch (error) {
      console.error(
        `Error writing redacted product mapping to DB for productIds: ${effectiveProductIds}, isRedacted: ${data.isRedacted}`,
        error,
      );
      throw error;
    }
  }

  return {
    statusCode: 400,
    body: `Invalid request body (RedactPayload): expected identifier/identifiers, productId/productIds, or customerId. Received: ${data && JSON.stringify(data)}`,
  };
});
