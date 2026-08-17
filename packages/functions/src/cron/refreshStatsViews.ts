import { Config } from "sst/node/config";
import { rebuildUniqueStats } from "@commonsdb/core/statistics/statisticsUtil";
import { notifySlack } from "@commonsdb/core/searchUtils/notifyUtil";

/**
 * Cron job that runs the periodic full recompute of the incremental stats
 * tables in the cdb_stats Postgres DB.
 *
 * The dashboard does NOT wait for this: stats_daily_unique/stats_media_unique
 * are maintained incrementally by a declarations trigger on every ingest, so
 * they are always current. This job is only drift correction, scheduled a few
 * times a day. A timed-out run rolls back and is harmless.
 */
export async function handler(_evt: any, _ctx: any) {
  console.log("[Rebuild Stats] Starting drift-correction rebuild...");
  console.log("[Rebuild Stats] Stage:", Config.STAGE);

  const startedAt = Date.now();

  try {
    await rebuildUniqueStats(Config.SECRET_CDB_STATS_PG_URL);
    const durationMs = Date.now() - startedAt;
    console.log(`[Rebuild Stats] Completed in ${durationMs}ms`);
    return { ok: true, durationMs };
  } catch (error: any) {
    console.error("[Rebuild Stats] Failed:", error);
    try {
      await notifySlack(
        {
          message: "ERROR rebuilding statistics tables",
          env: Config.STAGE,
          error: error?.message || String(error),
        },
        "error",
      );
    } catch (notifyErr) {
      console.error("[Rebuild Stats] Failed to notify Slack:", notifyErr);
    }
    throw error;
  }
}
