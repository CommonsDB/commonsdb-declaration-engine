import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import {
  storeFullAnalyticsData,
  getCurrentAnalyticsData,
  COUNTER_KEYS,
  setAnalyticsCounter,
} from "@commonsdb/core/searchUtils/analyticsUtil";
import { countUniqueIsccCodesByDeclarer } from "@commonsdb/core/searchUtils/s3Util";
import { notifySlack } from "@commonsdb/core/searchUtils/notifyUtil";

/**
 * Setup and initialize the analytics system
 * This function performs initial data population and system verification
 */
export const setupAnalytics = ApiHandler(async (_evt) => {
  console.log("Analytics system setup initiated");

  // Authentication check
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const startTime = Date.now();
  const setupResults: any = {
    steps: [],
    analytics: {},
    performance: {},
    version: Config.VERSION,
  };

  try {
    // Step 1: Check current analytics state
    console.log("Step 1: Checking current analytics state...");
    setupResults.steps.push("Checking current analytics state");

    const currentData = await getCurrentAnalyticsData();
    setupResults.analytics.currentState = {
      totalUniqueIscc: currentData.totalUniqueIscc,
      totalDeclarations: currentData.totalDeclarations,
      declarerCount: currentData.declarerStats.length,
      lastCalculated: currentData.lastCalculated,
      lastCalculatedIso: currentData.lastCalculated > 0 ? new Date(currentData.lastCalculated).toISOString() : "Never",
    };

    console.log(
      `Current state: ${currentData.totalUniqueIscc} unique ISCC codes, ${currentData.declarerStats.length} declarers`,
    );

    // Step 2: Perform initial full calculation if needed
    const needsInitialization = currentData.lastCalculated === 0 || _evt.queryStringParameters?.force_init === "true";

    if (needsInitialization) {
      console.log("Step 2: Performing initial full calculation...");
      setupResults.steps.push("Performing initial full calculation");

      const s3Data = await countUniqueIsccCodesByDeclarer();

      const analyticsData = {
        totalUniqueIscc: s3Data.totalUniqueIscc,
        totalDeclarations: s3Data.totalDeclarations,
        declarerStats: s3Data.declarerStats.map((stat) => ({
          declarerId: stat.declarerId,
          uniqueIsccCount: stat.uniqueIsccCount,
          totalDeclarations: stat.totalDeclarations,
        })),
        lastCalculated: Date.now(),
      };

      await storeFullAnalyticsData(analyticsData);

      setupResults.analytics.initialCalculation = {
        totalUniqueIscc: analyticsData.totalUniqueIscc,
        totalDeclarations: analyticsData.totalDeclarations,
        declarerCount: analyticsData.declarerStats.length,
        calculationTime: Date.now() - startTime,
      };

      console.log(`Initial calculation complete: ${analyticsData.totalUniqueIscc} unique ISCC codes`);
    } else {
      console.log("Step 2: Skipping initial calculation (data already exists)");
      setupResults.steps.push("Skipping initial calculation (data already exists)");
    }

    // Step 3: Verify system health
    console.log("Step 3: Verifying system health...");
    setupResults.steps.push("Verifying system health");

    const healthCheck = await performHealthCheck();
    setupResults.analytics.healthCheck = healthCheck;

    // Step 4: Initialize per-declarer counters
    console.log("Step 4: Initializing per-declarer counters...");
    setupResults.steps.push("Initializing per-declarer counters");

    const updatedData = await getCurrentAnalyticsData();
    let initializedCounters = 0;

    for (const declarer of updatedData.declarerStats) {
      const declarerUniqueKey = `declarer_${declarer.declarerId}_unique_iscc`;
      const declarerTotalKey = `declarer_${declarer.declarerId}_total_declarations`;
      try {
        await setAnalyticsCounter(declarerUniqueKey, declarer.uniqueIsccCount);
        await setAnalyticsCounter(declarerTotalKey, declarer.totalDeclarations);
        initializedCounters++;
      } catch (error) {
        console.error(`Failed to initialize counters for ${declarer.declarerId}:`, error);
      }
    }

    setupResults.analytics.declarerCounters = {
      total: updatedData.declarerStats.length,
      initialized: initializedCounters,
    };

    // Step 5: Performance summary
    const totalTime = Date.now() - startTime;
    setupResults.performance = {
      totalTimeMs: totalTime,
      totalTimeSeconds: (totalTime / 1000).toFixed(2),
    };

    console.log(`Analytics setup completed successfully in ${totalTime}ms`);

    // Send success notification
    await notifySlack(
      {
        message: "Analytics System Setup Complete",
        env: Config.STAGE,
        version: Config.VERSION,
        totalUniqueIscc: updatedData.totalUniqueIscc,
        totalDeclarations: updatedData.totalDeclarations,
        totalDeclarers: updatedData.declarerStats.length,
        setupTimeMs: totalTime,
        stepsCompleted: setupResults.steps.length,
        healthStatus: healthCheck.status,
      },
      "success",
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Analytics system setup completed successfully",
        ...setupResults,
      }),
    };
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error("Error during analytics setup:", error);

    setupResults.error = {
      message: error instanceof Error ? error.message : "Unknown error",
      timeMs: errorTime,
    };

    // Send error notification
    await notifySlack(
      {
        message: "Analytics System Setup Failed",
        env: Config.STAGE,
        version: Config.VERSION,
        error: error,
        setupTimeMs: errorTime,
        stepsCompleted: setupResults.steps.length,
      },
      "error",
    );

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Analytics system setup failed",
        ...setupResults,
      }),
    };
  }
});

/**
 * Perform health check on the analytics system
 */
async function performHealthCheck(): Promise<{
  status: "healthy" | "warning" | "error";
  checks: Array<{ name: string; status: boolean; message?: string }>;
}> {
  const checks = [];

  try {
    // Check if we can read analytics data
    const data = await getCurrentAnalyticsData();
    checks.push({
      name: "Analytics data readable",
      status: true,
      message: `Found ${data.totalUniqueIscc} unique ISCC codes`,
    });

    // Check if data is recent (within last 2 hours)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const isDataRecent = data.lastCalculated > twoHoursAgo;
    checks.push({
      name: "Data freshness",
      status: isDataRecent,
      message: isDataRecent
        ? "Data is recent"
        : `Data is ${Math.round((Date.now() - data.lastCalculated) / (60 * 60 * 1000))} hours old`,
    });

    // Check if we have any data
    const hasData = data.totalUniqueIscc > 0;
    checks.push({
      name: "Data availability",
      status: hasData,
      message: hasData ? "Analytics data available" : "No analytics data found",
    });
  } catch (error) {
    checks.push({
      name: "Analytics system accessibility",
      status: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  const failedChecks = checks.filter((check) => !check.status);
  const status = failedChecks.length === 0 ? "healthy" : failedChecks.length <= 1 ? "warning" : "error";

  return { status, checks };
}

/**
 * Get system status (lighter version for monitoring)
 */
export const getAnalyticsStatus = ApiHandler(async (_evt) => {
  // Authentication check
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    const healthCheck = await performHealthCheck();
    const currentData = await getCurrentAnalyticsData();

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: healthCheck.status,
        checks: healthCheck.checks,
        analytics: {
          totalUniqueIscc: currentData.totalUniqueIscc,
          totalDeclarations: currentData.totalDeclarations,
          declarerCount: currentData.declarerStats.length,
          lastCalculated: currentData.lastCalculated,
          lastCalculatedIso:
            currentData.lastCalculated > 0 ? new Date(currentData.lastCalculated).toISOString() : "Never",
        },
        version: Config.VERSION,
        timestamp: Date.now(),
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        version: Config.VERSION,
        timestamp: Date.now(),
      }),
    };
  }
});
