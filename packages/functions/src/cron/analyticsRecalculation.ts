import { Config } from "sst/node/config";
import { ApiHandler } from "sst/node/api";
import { countUniqueIsccCodesByDeclarer, UniqueIsccByDeclarerResponse } from "@commonsdb/core/searchUtils/s3Util";
import {
  storeFullAnalyticsData,
  AnalyticsData,
  DeclarerStats,
  getCurrentAnalyticsData,
  clearIsccCodeCache,
} from "@commonsdb/core/searchUtils/analyticsUtil";
import { notifySlack } from "@commonsdb/core/searchUtils/notifyUtil";

export async function handler(_evt: any) {
  console.log("Analytics recalculation cron job started");
  console.log("Version:", Config.VERSION);

  const startTime = Date.now();

  try {
    // Get current analytics data to compare
    const currentData = await getCurrentAnalyticsData();
    console.log(
      `Current cached data: ${currentData.totalUniqueIscc} unique ISCC codes, last calculated: ${new Date(currentData.lastCalculated).toISOString()}`,
    );

    // Perform full calculation from S3
    console.log("Starting full calculation from S3 bucket...");
    const s3Data: UniqueIsccByDeclarerResponse = await countUniqueIsccCodesByDeclarer();

    const calculationTime = Date.now() - startTime;
    console.log(`Full calculation completed in ${calculationTime}ms`);

    // Transform data to match our analytics format
    const analyticsData: AnalyticsData = {
      totalUniqueIscc: s3Data.totalUniqueIscc,
      totalDeclarations: s3Data.totalDeclarations,
      declarerStats: s3Data.declarerStats.map((stat) => ({
        declarerId: stat.declarerId,
        uniqueIsccCount: stat.uniqueIsccCount,
        totalDeclarations: stat.totalDeclarations,
      })),
      lastCalculated: Date.now(),
    };

    // Store the calculated data
    await storeFullAnalyticsData(analyticsData);

    // Clear the in-memory ISCC cache to ensure fresh data
    clearIsccCodeCache();

    const totalTime = Date.now() - startTime;
    console.log(`Analytics recalculation completed successfully in ${totalTime}ms`);

    // Calculate drift from real-time counters
    const drift = Math.abs(analyticsData.totalUniqueIscc - currentData.totalUniqueIscc);
    const driftPercentage = currentData.totalUniqueIscc > 0 ? (drift / currentData.totalUniqueIscc) * 100 : 0;

    console.log(`Data drift: ${drift} ISCC codes (${driftPercentage.toFixed(2)}%)`);

    // Send notification about successful recalculation
    await notifySlack(
      {
        message: "Analytics Recalculation Complete",
        env: Config.STAGE,
        version: Config.VERSION,
        totalUniqueIscc: analyticsData.totalUniqueIscc,
        totalDeclarations: analyticsData.totalDeclarations,
        totalDeclarers: analyticsData.declarerStats.length,
        calculationTimeMs: calculationTime,
        totalTimeMs: totalTime,
        dataDrift: drift,
        driftPercentage: driftPercentage.toFixed(2) + "%",
        lastCalculated: new Date(analyticsData.lastCalculated).toISOString(),
      },
      "success",
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Analytics recalculation completed successfully",
        data: {
          totalUniqueIscc: analyticsData.totalUniqueIscc,
          totalDeclarations: analyticsData.totalDeclarations,
          totalDeclarers: analyticsData.declarerStats.length,
          calculationTimeMs: calculationTime,
          totalTimeMs: totalTime,
          dataDrift: drift,
          driftPercentage,
          lastCalculated: analyticsData.lastCalculated,
        },
        version: Config.VERSION,
      }),
    };
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error("Error in analytics recalculation:", error);

    // Send error notification
    await notifySlack(
      {
        message: "Analytics Recalculation Failed",
        env: Config.STAGE,
        version: Config.VERSION,
        error: error,
        errorTimeMs: errorTime,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
      "error",
    );

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Analytics recalculation failed",
        error: error instanceof Error ? error.message : "Unknown error",
        version: Config.VERSION,
      }),
    };
  }
}

// Export for manual testing via API
export const testHandler = ApiHandler(async (_evt) => {
  console.log("Manual analytics recalculation triggered via API");

  // Authentication check
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  // Call the main handler
  return await handler(_evt);
});
