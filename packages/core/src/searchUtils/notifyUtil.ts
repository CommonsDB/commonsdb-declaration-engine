import { Config } from "sst/node/config";
import { Table } from "sst/node/table";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({});

interface SlackMessage {
  message: string;
  [key: string]: any;
}

// ─── Slack notification key rules ────────────────────────────────────────────
//
// Each entry in SLACK_KEY_RULES matches companyId values via substring (.includes).
//
//   block           – true  → notification is always suppressed (permanent blocklist)
//   bypassRateLimit – true  → notification always fires, rate limit is never applied
//
// Keys with neither flag are subject to the default rate limit below.
// ─────────────────────────────────────────────────────────────────────────────
interface SlackKeyRule {
  key: string;
  /** Permanently suppress all Slack notifications for this key. */
  block?: boolean;
  /** Bypass the rate limit — notifications always fire (as long as not blocked). */
  bypassRateLimit?: boolean;
  /** Per-key rate limit override. When set, takes precedence over the defaults. */
  rateLimit?: {
    max: number;
    windowMs: number;
  };
}

// Rules are loaded from the SECRET_SLACK_NOTIFY_RULES secret: a JSON array of
// SlackKeyRule objects, e.g.
//   [{"key":"MONITOR","block":true},
//    {"key":"did:key:…","rateLimit":{"max":5,"windowMs":600000}}]
// "_" or an empty/invalid value means no per-key rules (defaults apply to all).
// Loaded lazily so importing this module does not require the binding.
let slackKeyRulesCache: SlackKeyRule[] | null = null;
function getSlackKeyRules(): SlackKeyRule[] {
  if (slackKeyRulesCache !== null) return slackKeyRulesCache;
  const raw = Config.SECRET_SLACK_NOTIFY_RULES;
  if (!raw || raw === "_") {
    slackKeyRulesCache = [];
    return slackKeyRulesCache;
  }
  try {
    const parsed = JSON.parse(raw);
    slackKeyRulesCache = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[notifyUtil] SECRET_SLACK_NOTIFY_RULES is not valid JSON — no per-key rules applied:", err);
    slackKeyRulesCache = [];
  }
  return slackKeyRulesCache;
}

// ─── Rate-limit config ────────────────────────────────────────────────────────
// Applied to all keys that are not blocked and not in the bypass list above.
const SLACK_RATE_LIMIT_MAX = 5;
const SLACK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// ─── Rate-limit design ──────────────────────────────────────────────────────
// A plain in-memory Map cannot enforce a global limit: Slack notifications are
// emitted from the Kinesis consumer, which runs across many parallel and
// frequently recycled Lambda execution environments. Each container kept its own
// counter, and it reset on every cold start (~10 min pattern) — so the limit was
// effectively never held.
//
// But hitting DynamoDB on *every* check would be wasteful. So this is a two-tier
// limiter that keeps DynamoDB traffic minimal:
//
//   Tier 1 (in-memory, no I/O): once a container knows a key is over the limit
//     for the current window, it short-circuits from memory — ZERO DynamoDB calls
//     for the noisy/spammy case we actually care about suppressing.
//
//   Tier 2 (DynamoDB authority): consulted ONLY while a key is still under its
//     local allowance. Because the allowance is small (e.g. 5/window), each
//     container makes at most ~max+1 DynamoDB writes per key per window, then
//     serves the rest of the window from memory.
//
// Net effect: bounded, tiny DynamoDB usage; correct global cap across containers.
// Fails OPEN on DynamoDB errors — Slack is the only error-recovery signal for the
// ingest pipeline, so dropping alerts is worse than briefly exceeding the limit.
// ─────────────────────────────────────────────────────────────────────────────

// Per-container view of each key's current window. `blockedUntil` lets us answer
// "limited" with no DynamoDB call once the cap is known to be reached.
interface LocalWindowState {
  windowStart: number; // epoch ms — start of the window this container is tracking
  localCount: number; // notifications this container has let through in the window
  blockedUntil: number; // epoch ms — short-circuit "limited" until this time (0 = unknown)
}
const _localState = new Map<string, LocalWindowState>();

function findRule(companyId: string): SlackKeyRule | undefined {
  return getSlackKeyRules().find((r) => companyId.includes(r.key));
}

/**
 * Atomically bump the shared per-key counter in DynamoDB and return the new count
 * for the current window. Returns `null` on any DynamoDB error (caller fails open).
 *
 * Two conditional UpdateItem calls keep it correct under concurrency:
 *   1. Increment if an active window exists (windowStart still within range).
 *   2. Otherwise start a fresh window — guarded so only one racing invocation wins;
 *      losers retry the increment path.
 */
async function bumpGlobalCount(companyId: string, now: number, windowMs: number, attempt = 0): Promise<number | null> {
  const windowFloor = now - windowMs; // windows that started at/before this are expired
  const tableName = Table.SlackRateLimit.tableName;

  try {
    const res = await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { key: { S: companyId } },
        ConditionExpression: "attribute_exists(#k) AND windowStart > :floor",
        UpdateExpression: "ADD #count :one",
        ExpressionAttributeNames: { "#k": "key", "#count": "count" },
        ExpressionAttributeValues: {
          ":floor": { N: String(windowFloor) },
          ":one": { N: "1" },
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(res.Attributes?.count?.N ?? "0");
  } catch (err: any) {
    if (err?.name !== "ConditionalCheckFailedException") {
      console.error("[notifyUtil] DynamoDB rate-limit increment failed, allowing notification:", err);
      return null; // fail open
    }
    // No item yet, or window expired → start a fresh window below.
  }

  try {
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { key: { S: companyId } },
        ConditionExpression: "attribute_not_exists(#k) OR windowStart <= :floor",
        UpdateExpression: "SET windowStart = :now, #count = :one, expireAt = :ttl",
        ExpressionAttributeNames: { "#k": "key", "#count": "count" },
        ExpressionAttributeValues: {
          ":floor": { N: String(windowFloor) },
          ":now": { N: String(now) },
          ":one": { N: "1" },
          // TTL (Unix seconds) — let DynamoDB clean up stale rows shortly after the window ends.
          ":ttl": { N: String(Math.floor((now + windowMs) / 1000) + 60) },
        },
      }),
    );
    return 1; // first notification in a brand-new window
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException" && attempt < 2) {
      // Another invocation reset the window first — retry the increment path.
      return bumpGlobalCount(companyId, now, windowMs, attempt + 1);
    }
    console.error("[notifyUtil] DynamoDB rate-limit reset failed, allowing notification:", err);
    return null; // fail open
  }
}

/** Returns `true` when the Slack notification for `companyId` should be suppressed. */
async function isRateLimited(companyId: string, rule?: SlackKeyRule): Promise<boolean> {
  const max = rule?.rateLimit?.max ?? SLACK_RATE_LIMIT_MAX;
  const windowMs = rule?.rateLimit?.windowMs ?? SLACK_RATE_LIMIT_WINDOW_MS;
  const now = Date.now();

  // Roll the local window if it has expired (or first time we see this key).
  let local = _localState.get(companyId);
  if (!local || now - local.windowStart >= windowMs) {
    local = { windowStart: now, localCount: 0, blockedUntil: 0 };
    _localState.set(companyId, local);
  }

  // Tier 1 — pure memory, NO DynamoDB:
  // already known to be over the limit this window, or this container alone has
  // already let through its full allowance.
  if (now < local.blockedUntil || local.localCount >= max) {
    local.blockedUntil = local.windowStart + windowMs;
    return true;
  }

  // Tier 2 — under the local allowance: confirm against the shared global counter.
  const globalCount = await bumpGlobalCount(companyId, now, windowMs);

  if (globalCount === null) {
    // DynamoDB unavailable → fail open, but still count locally so a single
    // container can't spam unbounded while DynamoDB is down.
    local.localCount++;
    return false;
  }

  if (globalCount > max) {
    // Other containers already used up the global allowance → block and remember
    // it so the rest of this window is served from memory (Tier 1).
    local.blockedUntil = local.windowStart + windowMs;
    console.log(
      `[notifyUtil] Slack notification rate-limited for key "${companyId}": ` +
        `${globalCount}/${max} in current ${windowMs / 60000}-min window`,
    );
    return true;
  }

  local.localCount++;
  return false;
}

export async function notifySlack(
  message: SlackMessage,
  state: "error" | "success" | "warning" | "info" = "success",
  channel: "events" | "b2c" | "roy" = "events",
): Promise<void> {
  try {
    if (Config.STAGE === "dev") {
      console.log("Skipping Slack notification in dev environment");
      return;
    }
    const formattedMessagePayload = formatMessage(message, state);

    // Ensure the payload is stringified only once
    const stringifiedMessage = stringifyIfNeeded(formattedMessagePayload);

    // Webhook URL comes from SST secrets (SECRET_SLACK_WEBHOOK_URL). The
    // `channel` parameter is kept for call-site compatibility; all channels
    // post to the configured webhook.
    const fullUrl = Config.SECRET_SLACK_WEBHOOK_URL;
    console.log("Sending message to Slack:", fullUrl, stringifiedMessage);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: stringifiedMessage,
    });

    if (!response.ok) {
      console.log("Received non-200 status code from Slack:", response.status, await response.text());
    } else {
      console.log("SLACK Message sent successfully");
    }
  } catch (error) {
    console.error("Error sending message to Slack:", error);
  }
}

const formatMessage = (message: SlackMessage, state: "success" | "error" | "warning" | "info") => {
  const msg = message.message || "Notification";
  console.log("Slack notification formatMessage Config.STAGE is: ", Config.STAGE);

  const envName = Config.STAGE === "cdb-b2b-api-prod" ? "COMMONS DB PROD" : `COMMONS DB (${Config.STAGE})`;

  const notificationType =
    state === "success"
      ? `:large_green_circle: ${envName} *${msg}*`
      : state === "info"
        ? `:large_blue_circle: ${envName} *${msg}*`
        : state === "warning"
          ? `:large_yellow_circle: ${envName} *WARNING ${msg}*`
          : `:red_circle: ${envName} *ERROR ${msg}*`;

  let formattedMessage = {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: notificationType,
        },
      },
    ],
  };

  // const MAX_FIELD_LENGTH = 500; // Slack's max block size is 3k?
  // const TRIM_LENGTH = 100;

  const additionalFields = Object.entries(message)
    .filter(([key]) => key !== "message")
    .map(([key, val]) => {
      const isLink = typeof val === "string" && val.toLowerCase().startsWith("http");
      return {
        type: "section",
        text: {
          type: "mrkdwn",
          text: isLink ? `\n*<${val}|${key}>*` : `*${key}*: ${val}`,
        },
      };
    });

  if (additionalFields.length > 0) {
    formattedMessage.blocks.push(...additionalFields);
  }

  // Add a divider block at the end
  //@ts-ignore
  formattedMessage.blocks.push({
    type: "divider",
  });

  return formattedMessage;
};

const stringifyIfNeeded = (val: any): string => {
  if (typeof val === "string") {
    return val;
  } else if (typeof val === "object") {
    return JSON.stringify(val, null, 4);
  } else {
    return String(val);
  }
};

export async function shouldNotifySlack(companyId: string): Promise<boolean> {
  const rule = findRule(companyId);

  if (rule?.block) return false;
  if (rule?.bypassRateLimit) return true;

  return !(await isRateLimited(companyId, rule));
}
