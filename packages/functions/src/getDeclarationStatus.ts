import { getIdentifierKeyValuePair } from "@commonsdb/core/utils/fieldMapping";
import { getDeclarationStatusByIdentifier } from "@commonsdb/core/searchUtils/tableDeclarationStatusUtil";
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";

/**
 * Formats a timestamp (milliseconds since epoch) to a human-readable string
 * @param timestamp - Timestamp in milliseconds since epoch
 * @returns Human-readable date/time string
 */
function formatTimestampHumanReadable(timestamp: number | undefined): string | undefined {
  if (!timestamp) return undefined;

  try {
    const date = new Date(timestamp);

    // Format: "January 3, 2026 at 2:45:30 PM UTC"
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    };

    return date.toLocaleString("en-US", options);
  } catch {
    return String(timestamp); // Return original as string if parsing fails
  }
}

// Returns the processing status of a declaration by identifier
export const getDeclarationStatus = ApiHandler(async (_evt) => {
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  console.log(Config.VERSION);
  console.log("STAGE", Config.STAGE);

  const [fieldKey] = getIdentifierKeyValuePair();
  const fieldValue = _evt.queryStringParameters?.[fieldKey];
  console.log("identifier", fieldKey, fieldValue);

  if (!fieldValue) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Missing identifier",
        message: `Query parameter '${fieldKey}' is required`,
      }),
    };
  }

  try {
    const status = await getDeclarationStatusByIdentifier(fieldValue);

    if (!status) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: "Not found",
          message: `No declaration status found for identifier: ${fieldValue}`,
        }),
      };
    }

    // Generate human-readable timestamps
    const createdAtDateTime = formatTimestampHumanReadable(status.createdAt);
    const updatedAtDateTime = formatTimestampHumanReadable(status.updatedAt);

    // Log status details with human-readable timestamps
    console.log("[Declaration Status] ========================================");
    console.log("[Declaration Status] Identifier:", status.identifier);
    console.log("[Declaration Status] Status:", status.status);
    console.log("[Declaration Status] Message:", status.message || "N/A");
    console.log("[Declaration Status] Created At:", status.createdAt);
    console.log("[Declaration Status] Created At (DateTime):", createdAtDateTime || "N/A");
    console.log("[Declaration Status] Updated At:", status.updatedAt);
    console.log("[Declaration Status] Updated At (DateTime):", updatedAtDateTime || "N/A");
    console.log("[Declaration Status] ========================================");

    return {
      statusCode: 200,
      body: JSON.stringify({
        identifier: status.identifier,
        status: status.status,
        message: status.message,
        createdAt: status.createdAt,
        createdAtDateTime,
        updatedAt: status.updatedAt,
        updatedAtDateTime,
        version: Config.VERSION,
      }),
    };
  } catch (err) {
    console.error("Error getting declaration status:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        errorBody: JSON.stringify(err),
        message: "Failed to retrieve declaration status",
      }),
    };
  }
});
