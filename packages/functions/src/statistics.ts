import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { getStatistics } from "@commonsdb/core/statistics/statisticsUtil";

/**
 * GET /api/v1/statistics
 *
 * Aggregates declaration statistics from the `cdb_stats` Postgres database
 * (populated by the commons-db-statistics pipeline) into the single combined
 * payload the registry-viewer-ui statistics page consumes.
 *
 * Auth mirrors the other search endpoints: an `x-api-key` header matching one of
 * the Zuplo access keys. Zuplo sits in front and injects this header.
 */
export const statistics = ApiHandler(async (_evt) => {
  const apiKey = _evt.headers["x-api-key"];
  const allowedKeys = [Config.SECRET_ZUPLO_ACCESS_KEY, Config.SECRET_ZUPLO_ACCESS_KEY_SEARCH_B2B];
  if (!apiKey || !allowedKeys.includes(apiKey)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    const denylistDids = (Config.RANDOM_DECLARER_ID_DENYLIST || "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d && d !== "_");

    const data = await getStatistics({
      connectionString: Config.SECRET_CDB_STATS_PG_URL,
      denylistDids,
      minDate: Config.MIN_DECLARATION_TIMESTAMP,
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify({ ...data, version: Config.VERSION }),
    };
  } catch (error) {
    console.error("statistics: failed to build statistics payload", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to build statistics",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
});
