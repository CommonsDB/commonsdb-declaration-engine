import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { EventBus } from "sst/node/event-bus";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { getFastAnalyticsData } from "@commonsdb/core/searchUtils/analyticsUtil";

export const getUniqueIsccAmount = ApiHandler(async (_evt) => {
  console.log("getUniqueIsccAmount called:");

  // Authentication check
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  console.log(Config.VERSION);

  try {
    // Always use fast analytics data - never block for recalculation
    console.log("Getting unique ISCC count from analytics cache");
    const fastData = await getFastAnalyticsData();

    // Check if data is stale (older than 2 hours) and trigger background recalculation
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const isDataStale = fastData.lastUpdated < twoHoursAgo;

    if (isDataStale && fastData.lastUpdated > 0) {
      console.log("Data is stale, triggering background recalculation");
      // Trigger background recalculation without waiting
      triggerBackgroundRecalculation().catch((error) => {
        console.error("Failed to trigger background recalculation:", error);
        // Don't throw - this shouldn't affect the response
      });
    }

    const response = {
      statusCode: 200,
      body: JSON.stringify({
        unique_iscc: {
          declarerStats: fastData.declarerStats,
          totalUniqueIscc: fastData.totalUniqueIscc,
          totalDeclarations: fastData.totalDeclarations,
        },
        data_source: fastData.dataSource,
        last_updated: fastData.lastUpdated,
        last_updated_iso: fastData.lastUpdated > 0 ? new Date(fastData.lastUpdated).toISOString() : "Never",
        is_stale: isDataStale,
        background_refresh_triggered: isDataStale && fastData.lastUpdated > 0,
        version: Config.VERSION,
      }),
    };

    console.log("will return (from cache):", response);
    return response;
  } catch (error) {
    console.error("Error getting unique ISCC amounts:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error while getting unique ISCC amounts",
        error_message: error instanceof Error ? error.message : "Unknown error",
        version: Config.VERSION,
      }),
    };
  }
});

/**
 * Trigger background recalculation using SST EventBus
 * This runs asynchronously without blocking the response
 */
async function triggerBackgroundRecalculation(): Promise<void> {
  try {
    const eventBridgeClient = new EventBridgeClient({});

    console.log("Publishing analytics recalculation event to SST EventBus");

    const command = new PutEventsCommand({
      Entries: [
        {
          Source: "commonsdb.analytics",
          DetailType: "Analytics Recalculation Request",
          Detail: JSON.stringify({
            source: "background-trigger",
            triggeredBy: "getUniqueIsccAmount",
            timestamp: Date.now(),
            reason: "stale-data-detected",
          }),
          EventBusName: EventBus.bus.eventBusName,
        },
      ],
    });

    await eventBridgeClient.send(command);
    console.log("Background recalculation event published successfully");
  } catch (error) {
    console.error("Error triggering background recalculation:", error);
    // Don't throw - this is a best-effort background operation
  }
}
