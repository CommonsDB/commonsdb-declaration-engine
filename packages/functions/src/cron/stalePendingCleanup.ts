import { Config } from "sst/node/config";
import {
  cleanupStalePendingDeclarations,
  STALE_PENDING_THRESHOLD_MS,
  CleanupResult,
} from "@commonsdb/core/searchUtils/tableDeclarationStatusUtil";
import { notifySlack } from "@commonsdb/core/searchUtils/notifyUtil";

/**
 * Cron job handler that cleans up stale pending declarations.
 * Declarations stuck in "pending" state for more than 1 hour are marked as "failed".
 *
 * This ensures declarations don't remain in pending state forever if something goes wrong
 * with the Kinesis stream processing or any intermediate step.
 */
export async function handler(_evt: any, _ctx: any) {
  console.log("[Stale Pending Cleanup] Starting cleanup job...");
  console.log("[Stale Pending Cleanup] Version:", Config.VERSION);
  console.log("[Stale Pending Cleanup] Stage:", Config.STAGE);
  console.log(
    "[Stale Pending Cleanup] Threshold:",
    STALE_PENDING_THRESHOLD_MS,
    "ms (",
    STALE_PENDING_THRESHOLD_MS / 1000 / 60,
    "minutes)",
  );

  let result: CleanupResult;

  try {
    result = await cleanupStalePendingDeclarations(STALE_PENDING_THRESHOLD_MS);

    console.log("[Stale Pending Cleanup] Cleanup completed successfully");
    console.log(`[Stale Pending Cleanup] Processed: ${result.processed}`);
    console.log(`[Stale Pending Cleanup] Successful: ${result.successful}`);
    console.log(`[Stale Pending Cleanup] Failed: ${result.failed}`);

    // Notify Slack if any declarations were cleaned up or if there were errors
    if (result.processed > 0) {
      await notifySlack(
        {
          message:
            result.failed > 0
              ? "⚠️ Stale Pending Cleanup: Completed with errors"
              : "✅ Stale Pending Cleanup: Completed successfully",
          env: Config.STAGE,
          processed: result.processed,
          successful: result.successful,
          failed: result.failed,
          thresholdMinutes: STALE_PENDING_THRESHOLD_MS / 1000 / 60,
          errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined, // Limit errors in notification
        },
        result.failed > 0 ? "error" : "info",
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Stale pending cleanup completed",
        ...result,
      }),
    };
  } catch (error: any) {
    console.error("[Stale Pending Cleanup] Fatal error during cleanup:", error);

    //Notify about fatal error
    try {
      await notifySlack(
        {
          message: "🚨 Stale Pending Cleanup: FATAL ERROR",
          env: Config.STAGE,
          error: error.message || String(error),
        },
        "error",
      );
    } catch (notifyErr) {
      console.error("[Stale Pending Cleanup] Failed to notify Slack:", notifyErr);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Stale pending cleanup failed",
        error: error.message || String(error),
      }),
    };
  }
}

/**
 * Manually-triggerable handler exposed on POST /api/v1/cleanupStalePending.
 * Mutating, so it requires the shared gateway access key.
 */
export async function testHandler(_evt: any, _ctx: any) {
  const apiKey = _evt.headers?.["x-api-key"];
  if (!apiKey || apiKey !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }
  console.log("[Stale Pending Cleanup] Manual cleanup triggered");
  return handler(_evt, _ctx);
}
