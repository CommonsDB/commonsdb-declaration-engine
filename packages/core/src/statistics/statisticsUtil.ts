import { Client } from "pg";
import { Config } from "sst/node/config";

/**
 * Statistics aggregation against the `cdb_stats` Postgres database that the
 * commons-db-statistics pipeline populates from S3 declaration files.
 *
 * All figures count UNIQUE ISCC codes, not declarations: the mv_stats_*_unique
 * views keep one row per ISCC — its latest declaration by date (ties broken by
 * ingestion order) — so a re-declared ISCC is counted once, attributed to the
 * declarer of that latest declaration.
 *
 * The Lambda reaches the RDS instance directly (the instance is publicly
 * reachable, so no VPC wiring is required). The connection string is provided
 * via the SECRET_CDB_STATS_PG_URL secret and passed in by the handler.
 *
 * The shapes returned here mirror the BE DTOs the registry-viewer-ui statistics
 * page expects. The FE owns the colour palette and the DID -> friendly supplier
 * name mapping, so we return raw DIDs as supplier ids/names.
 */

// ── DTO shapes (mirror registry-viewer-ui/src/api/types/statistics.ts) ────────

export interface IStatisticsSupplierApi {
  id: string;
  name: string;
  short?: string;
}

export interface IStatisticsKpiValue {
  value: number;
  delta: number;
  periodDays: number;
  label?: string;
  percent?: boolean;
  integer?: boolean;
}

export interface IStatisticsOverview {
  declarations: IStatisticsKpiValue;
  suppliers: IStatisticsKpiValue;
  updatedAt: string;
}

export interface IStatisticsTimeBucket {
  label: string;
  bucketStart: string;
}

export interface IStatisticsTimeSeries {
  supplierId: string;
  values: number[];
}

export interface IDeclarationsOverTime {
  granularity: "monthly";
  buckets: IStatisticsTimeBucket[];
  series: IStatisticsTimeSeries[];
}

export interface IStatisticsDistributionItem {
  id: string;
  name: string;
  value: number;
}

export interface IStatisticsDistribution {
  items: IStatisticsDistributionItem[];
  total: number;
}

export interface IStatisticsPdRationaleItem {
  id: string;
  name: string;
  long?: string;
  full?: string;
  value: number;
}

export interface IStatisticsPdRationale {
  items: IStatisticsPdRationaleItem[];
  total: number;
}

/** Per-declarer breakdown so the UI can filter every chart by supplier. */
export interface IStatisticsByDeclarer {
  license: IStatisticsDistribution;
  media: IStatisticsDistribution;
  pdRationale: IStatisticsPdRationale;
}

export interface IStatisticsResponse {
  suppliers: IStatisticsSupplierApi[];
  overview: IStatisticsOverview;
  declarationsOverTime: IDeclarationsOverTime;
  licenseDistribution: IStatisticsDistribution;
  mediaTypes: IStatisticsDistribution;
  pdRationale: IStatisticsPdRationale;
  /** Distributions keyed by declarer DID (same id space as `suppliers`). */
  byDeclarer: Record<string, IStatisticsByDeclarer>;
}

// ── Connection handling ───────────────────────────────────────────────────────
//
// A module-level pg.Pool leaks connections on Lambda: a frozen container keeps
// its TCP connections open server-side, so warm containers permanently hold RDS
// slots and exhaust the instance (Postgres 53300). We open a short-lived Client
// per invocation and always close it.

async function withClient<T>(connectionString: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
    application_name: `cdb-stats-view-refresh-${Config.STAGE}`,
    // RDS uses an AWS-managed cert chain; we do not pin it here.
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ── Stats drift correction ────────────────────────────────────────────────────

/**
 * Full recompute of the incremental stats tables (iscc_latest,
 * stats_daily_unique, stats_media_unique) from the declarations table.
 *
 * The read path does NOT depend on this: the declarations trigger (migration
 * 006 in commons-db-statistics) keeps the stats tables current on every
 * insert. This rebuild is only a periodic safety net against drift, run a few
 * times a day. If the Lambda times out mid-rebuild the transaction rolls back
 * and the trigger-maintained content stays untouched — a failed rebuild is
 * harmless.
 */
export async function rebuildUniqueStats(connectionString: string): Promise<void> {
  await withClient(connectionString, async (db) => {
    // Serialise with any other refresher/rebuilder (batch pipeline, manual run).
    const { rows } = await db.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('refresh_stats_views')) AS locked`,
    );
    if (!rows[0].locked) {
      console.log("stats rebuild already in progress — skipping this run");
      return;
    }

    try {
      console.log("rebuildUniqueStats: starting full recompute...");
      await db.query("SELECT rebuild_unique_stats()");
      console.log("rebuildUniqueStats: done");
    } finally {
      await db.query(`SELECT pg_advisory_unlock(hashtext('refresh_stats_views'))`);
    }
  });
}

// ── License normalisation ─────────────────────────────────────────────────────

const LICENSE_NAMES: Record<string, string> = {
  pdm: "Public Domain Mark",
  cc0: "CC0 1.0",
  ccby: "CC BY",
  ccbysa: "CC BY-SA",
  ccbync: "CC BY-NC",
  ccbynd: "CC BY-ND",
  other: "Other / unspecified",
};

const LICENSE_TOKEN_TO_ID: Record<string, string> = {
  by: "ccby",
  "by-sa": "ccbysa",
  "by-nc": "ccbync",
  "by-nc-sa": "ccbync",
  "by-nc-nd": "ccbync",
  "by-nd": "ccbynd",
};

/**
 * Collapse a raw rightsStatement URL into one of the FE license buckets.
 * Versions and jurisdictions (e.g. /by-sa/3.0/pl/) are intentionally ignored.
 */
export function licenseIdFromRightsStatement(raw: string | null): string {
  if (!raw) return "other";
  const url = raw.toLowerCase();

  if (url.includes("/publicdomain/mark")) return "pdm";
  if (url.includes("/publicdomain/zero")) return "cc0";

  const m = /\/licenses\/([a-z-]+)/.exec(url);
  if (m && LICENSE_TOKEN_TO_ID[m[1]]) return LICENSE_TOKEN_TO_ID[m[1]];

  return "other";
}

// ── Media type decoding from ISCC ─────────────────────────────────────────────
//
// An ISCC-CODE string is "ISCC:" + base32. The first byte of the decoded header
// is (MainType << 4) | SubType. For an ISCC-CODE the SubType nibble encodes the
// content media type (0=TEXT, 1=IMAGE, 2=AUDIO, 3=VIDEO, 4=MIXED).
//
// The first base32 char is always 'K' (MainType ISCC, high bit of SubType = 0),
// so the SubType is fully determined by the top 3 bits of the SECOND base32
// char: subType = floor(base32index(char) / 4).

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const MEDIA_NAMES: Record<string, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
  mixed: "Mixed",
  other: "Other",
};

const SUBTYPE_TO_MEDIA: Record<number, string> = {
  0: "text",
  1: "image",
  2: "audio",
  3: "video",
  4: "mixed",
};

/** Decode the media type id from the second base32 char of an ISCC body. */
export function mediaIdFromIsccSecondChar(char: string | null): string {
  if (!char) return "other";
  const idx = BASE32_ALPHABET.indexOf(char.toUpperCase());
  if (idx < 0) return "other";
  return SUBTYPE_TO_MEDIA[Math.floor(idx / 4)] ?? "other";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Earliest declaration date included in statistics (query filter only — DB rows are untouched). */
const DEFAULT_STATS_MIN_DATE = "2026-01-09";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Render a "YYYY-MM" key as e.g. "Jul '25". */
function monthLabelFromYm(ym: string): string {
  const [year, month] = ym.split("-");
  return `${MONTH_LABELS[Number(month) - 1]} '${year.slice(-2)}`;
}

function sortItemsDesc<T extends { value: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.value - a.value);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Main aggregation ──────────────────────────────────────────────────────────

export interface GetStatisticsOptions {
  connectionString: string;
  /** DIDs to exclude from every aggregation (e.g. test declarers). */
  denylistDids?: string[];
  /** Inclusive lower bound on declaration date (YYYY-MM-DD). Defaults to 2026-01-09. */
  minDate?: string;
}

export async function getStatistics(options: GetStatisticsOptions): Promise<IStatisticsResponse> {
  return withClient(options.connectionString, (db) => getStatisticsWithClient(db, options));
}

async function getStatisticsWithClient(
  db: Client,
  { denylistDids = [], minDate = DEFAULT_STATS_MIN_DATE }: GetStatisticsOptions,
): Promise<IStatisticsResponse> {
  const denySet = new Set(denylistDids.map((d) => d.trim()).filter(Boolean));

  // 1. Active declarers (suppliers)
  const declarersRes = await db.query<{ id: string; did: string }>("SELECT id, did FROM declarers ORDER BY id");
  const activeDeclarers = declarersRes.rows.filter((r) => !denySet.has(r.did));
  const activeIds = activeDeclarers.map((r) => Number(r.id));
  const idToDid = new Map<number, string>(activeDeclarers.map((r) => [Number(r.id), r.did]));

  const suppliers: IStatisticsSupplierApi[] = activeDeclarers.map((r) => ({
    id: r.did,
    name: r.did,
  }));

  // No active declarers — return an empty-but-valid payload.
  if (activeIds.length === 0) {
    return {
      suppliers: [],
      overview: {
        declarations: { value: 0, delta: 0, periodDays: 30 },
        suppliers: { value: 0, delta: 0, periodDays: 30, integer: true },
        updatedAt: new Date().toISOString(),
      },
      declarationsOverTime: { granularity: "monthly", buckets: [], series: [] },
      licenseDistribution: { items: [], total: 0 },
      mediaTypes: { items: [], total: 0 },
      pdRationale: { items: [], total: 0 },
      byDeclarer: {},
    };
  }

  // 2. Two parallel scans of pre-aggregated stats tables only — never declarations.
  //
  // stats_daily_unique / stats_media_unique are plain tables maintained
  // incrementally by the declarations trigger (migration 006): one bucket delta
  // per ingest, so they are always current — no view refresh in the read path.
  // They hold one row-bucket per unique ISCC (not per declaration): when an
  // ISCC was declared multiple times, only its latest declaration (by date,
  // ties broken by ingestion order) is counted, and the ISCC is attributed to
  // that latest declaration's declarer. All totals below are therefore counts
  // of unique ISCC codes. Empty-string rights/pd values are the tables' NULL
  // sentinels and are mapped back to NULL in the queries.
  const [dailyRes, mediaRes] = await Promise.all([
    db.query<{
      declarer_id: string;
      dt: string;
      ym: string;
      rights_statement: string | null;
      pd_rationale: string | null;
      n: string;
    }>(
      `SELECT
         declarer_id,
         to_char(date, 'YYYY-MM-DD') AS dt,
         to_char(date, 'YYYY-MM')    AS ym,
         NULLIF(rights_statement, '') AS rights_statement,
         NULLIF(pd_rationale, '')     AS pd_rationale,
         total::bigint               AS n
       FROM stats_daily_unique
       WHERE declarer_id = ANY($1::bigint[]) AND date >= $2::date`,
      [activeIds, minDate],
    ),
    db.query<{ declarer_id: string; c: string | null; n: string }>(
      `SELECT declarer_id, NULLIF(iscc_media_char, '') AS c, SUM(total)::bigint AS n
       FROM stats_media_unique
       WHERE declarer_id = ANY($1::bigint[]) AND date >= $2::date
       GROUP BY declarer_id, iscc_media_char`,
      [activeIds, minDate],
    ),
  ]);

  const d30 = isoDaysAgo(30);
  const d60 = isoDaysAgo(60);

  let total = 0;
  let last30 = 0;
  let prev30 = 0;
  const monthlyByDeclarerYm = new Map<string, number>();
  const licenseCounts = new Map<string, number>();
  const pdCounts = new Map<string, number>();

  // Per-declarer (by DID) breakdowns so the UI can filter each chart by supplier.
  const licenseByDid = new Map<string, Map<string, number>>();
  const pdByDid = new Map<string, Map<string, number>>();
  const mediaByDid = new Map<string, Map<string, number>>();

  const bump = (outer: Map<string, Map<string, number>>, did: string, key: string, n: number): void => {
    let inner = outer.get(did);
    if (!inner) {
      inner = new Map<string, number>();
      outer.set(did, inner);
    }
    inner.set(key, (inner.get(key) ?? 0) + n);
  };

  for (const row of dailyRes.rows) {
    const n = Number(row.n);
    total += n;
    if (row.dt > d30) last30 += n;
    else if (row.dt > d60) prev30 += n;

    const ymKey = `${row.declarer_id}:${row.ym}`;
    monthlyByDeclarerYm.set(ymKey, (monthlyByDeclarerYm.get(ymKey) ?? 0) + n);

    const did = idToDid.get(Number(row.declarer_id));

    const licenseId = licenseIdFromRightsStatement(row.rights_statement);
    licenseCounts.set(licenseId, (licenseCounts.get(licenseId) ?? 0) + n);
    if (did) bump(licenseByDid, did, licenseId, n);

    if (row.pd_rationale) {
      pdCounts.set(row.pd_rationale, (pdCounts.get(row.pd_rationale) ?? 0) + n);
      if (did) bump(pdByDid, did, row.pd_rationale, n);
    }
  }

  const delta = prev30 > 0 ? last30 / prev30 - 1 : 0;

  const overview: IStatisticsOverview = {
    declarations: { value: total, delta, periodDays: 30 },
    suppliers: {
      value: activeDeclarers.length,
      delta: 0,
      periodDays: 30,
      integer: true,
    },
    updatedAt: new Date().toISOString(),
  };
  // ── Declarations over time (monthly) ──────────────────────────────────────────
  const bucketKeys = [...new Set(dailyRes.rows.map((r) => r.ym))].sort();
  const buckets: IStatisticsTimeBucket[] = bucketKeys.map((ym) => ({
    label: monthLabelFromYm(ym),
    bucketStart: `${ym}-01T00:00:00.000Z`,
  }));
  const bucketIndex = new Map<string, number>(bucketKeys.map((k, i) => [k, i]));

  const seriesByDid = new Map<string, number[]>(activeDeclarers.map((r) => [r.did, new Array(buckets.length).fill(0)]));
  for (const [ymKey, n] of monthlyByDeclarerYm) {
    const sep = ymKey.indexOf(":");
    const declarerId = Number(ymKey.slice(0, sep));
    const ym = ymKey.slice(sep + 1);
    const did = idToDid.get(declarerId);
    if (!did) continue;
    const idx = bucketIndex.get(ym);
    if (idx === undefined) continue;
    seriesByDid.get(did)![idx] = n;
  }
  const series: IStatisticsTimeSeries[] = activeDeclarers.map((r) => ({
    supplierId: r.did,
    values: seriesByDid.get(r.did)!,
  }));

  const declarationsOverTime: IDeclarationsOverTime = {
    granularity: "monthly",
    buckets,
    series,
  };

  // ── License distribution ──────────────────────────────────────────────────────
  const licenseItems = sortItemsDesc(
    [...licenseCounts.entries()].map(([id, value]) => ({
      id,
      name: LICENSE_NAMES[id] ?? id,
      value,
    })),
  );
  const licenseDistribution: IStatisticsDistribution = {
    items: licenseItems,
    total: licenseItems.reduce((acc, it) => acc + it.value, 0),
  };

  // ── Media types ───────────────────────────────────────────────────────────────
  const mediaCounts = new Map<string, number>();
  for (const row of mediaRes.rows) {
    const id = mediaIdFromIsccSecondChar(row.c);
    const n = Number(row.n);
    mediaCounts.set(id, (mediaCounts.get(id) ?? 0) + n);
    const did = idToDid.get(Number(row.declarer_id));
    if (did) bump(mediaByDid, did, id, n);
  }
  const mediaItems = sortItemsDesc(
    [...mediaCounts.entries()].map(([id, value]) => ({
      id,
      name: MEDIA_NAMES[id] ?? id,
      value,
    })),
  );
  const mediaTypes: IStatisticsDistribution = {
    items: mediaItems,
    total: mediaItems.reduce((acc, it) => acc + it.value, 0),
  };

  // ── PD rationale ──────────────────────────────────────────────────────────────
  const pdItems: IStatisticsPdRationaleItem[] = sortItemsDesc(
    [...pdCounts.entries()].map(([id, value]) => ({
      id,
      name: id,
      value,
    })),
  );
  const pdRationale: IStatisticsPdRationale = {
    items: pdItems,
    total: pdItems.reduce((acc, it) => acc + it.value, 0),
  };

  // ── Per-declarer breakdowns ─────────────────────────────────────────────────
  const toDistribution = (
    counts: Map<string, number> | undefined,
    nameOf: (id: string) => string,
  ): IStatisticsDistribution => {
    const items = sortItemsDesc(
      [...(counts?.entries() ?? [])].map(([id, value]) => ({
        id,
        name: nameOf(id),
        value,
      })),
    );
    return { items, total: items.reduce((acc, it) => acc + it.value, 0) };
  };

  const byDeclarer: Record<string, IStatisticsByDeclarer> = {};
  for (const r of activeDeclarers) {
    byDeclarer[r.did] = {
      license: toDistribution(licenseByDid.get(r.did), (id) => LICENSE_NAMES[id] ?? id),
      media: toDistribution(mediaByDid.get(r.did), (id) => MEDIA_NAMES[id] ?? id),
      pdRationale: toDistribution(pdByDid.get(r.did), (id) => id),
    };
  }

  return {
    suppliers,
    overview,
    declarationsOverTime,
    licenseDistribution,
    mediaTypes,
    pdRationale,
    byDeclarer,
  };
}
