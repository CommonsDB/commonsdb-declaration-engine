import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Table } from "sst/node/table";

const dynamoDBClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDBClient);

export interface AnalyticsCounter {
  counterKey: string;
  counterValue: number;
  lastUpdated: number;
  metadata?: string;
}

export interface DeclarerStats {
  declarerId: string;
  uniqueIsccCount: number;
  totalDeclarations: number;
}

export interface AnalyticsData {
  totalUniqueIscc: number;
  totalDeclarations: number;
  declarerStats: DeclarerStats[];
  lastCalculated: number;
}

// Counter key constants
export const COUNTER_KEYS = {
  TOTAL_UNIQUE_ISCC: "total_unique_iscc",
  TOTAL_DECLARATIONS: "total_declarations",
  DECLARER_STATS: "declarer_stats",
  LAST_FULL_CALCULATION: "last_full_calculation",
} as const;

/**
 * Get a counter value from the analytics table
 */
export async function getAnalyticsCounter(counterKey: string): Promise<AnalyticsCounter | null> {
  try {
    const command = new GetCommand({
      TableName: Table.AnalyticsCounters.tableName,
      Key: { counterKey },
    });

    const result = await docClient.send(command);
    return (result.Item as AnalyticsCounter) || null;
  } catch (error) {
    console.error(`Error getting analytics counter ${counterKey}:`, error);
    throw error;
  }
}

/**
 * Set a counter value in the analytics table
 */
export async function setAnalyticsCounter(counterKey: string, counterValue: number, metadata?: string): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: Table.AnalyticsCounters.tableName,
      Item: {
        counterKey,
        counterValue,
        lastUpdated: Date.now(),
        metadata,
      },
    });

    await docClient.send(command);
  } catch (error) {
    console.error(`Error setting analytics counter ${counterKey}:`, error);
    throw error;
  }
}

/**
 * Increment a counter atomically
 */
export async function incrementAnalyticsCounter(counterKey: string, incrementBy: number = 1): Promise<number> {
  try {
    const command = new UpdateCommand({
      TableName: Table.AnalyticsCounters.tableName,
      Key: { counterKey },
      UpdateExpression: "ADD counterValue :increment SET lastUpdated = :timestamp",
      ExpressionAttributeValues: {
        ":increment": incrementBy,
        ":timestamp": Date.now(),
      },
      ReturnValues: "ALL_NEW",
    });

    const result = await docClient.send(command);
    return (result.Attributes?.counterValue as number) || 0;
  } catch (error) {
    console.error(`Error incrementing analytics counter ${counterKey}:`, error);
    throw error;
  }
}

/**
 * Store analytics data from full calculation
 */
export async function storeFullAnalyticsData(data: AnalyticsData): Promise<void> {
  try {
    const timestamp = Date.now();

    // Store total unique ISCC count
    await setAnalyticsCounter(COUNTER_KEYS.TOTAL_UNIQUE_ISCC, data.totalUniqueIscc);

    // Store total declarations count
    await setAnalyticsCounter(COUNTER_KEYS.TOTAL_DECLARATIONS, data.totalDeclarations);

    // Store declarer stats as JSON metadata
    await setAnalyticsCounter(
      COUNTER_KEYS.DECLARER_STATS,
      data.declarerStats.length,
      JSON.stringify(data.declarerStats),
    );

    // Update last calculation timestamp
    await setAnalyticsCounter(COUNTER_KEYS.LAST_FULL_CALCULATION, timestamp);

    console.log(
      `Stored full analytics data: ${data.totalUniqueIscc} unique ISCC codes, ${data.totalDeclarations} total declarations, ${data.declarerStats.length} declarers`,
    );
  } catch (error) {
    console.error("Error storing full analytics data:", error);
    throw error;
  }
}

/**
 * Get current analytics data from counters
 */
export async function getCurrentAnalyticsData(): Promise<AnalyticsData> {
  try {
    const [totalIsccCounter, totalDeclCounter, declarerStatsCounter, lastCalcCounter] = await Promise.all([
      getAnalyticsCounter(COUNTER_KEYS.TOTAL_UNIQUE_ISCC),
      getAnalyticsCounter(COUNTER_KEYS.TOTAL_DECLARATIONS),
      getAnalyticsCounter(COUNTER_KEYS.DECLARER_STATS),
      getAnalyticsCounter(COUNTER_KEYS.LAST_FULL_CALCULATION),
    ]);

    const totalUniqueIscc = totalIsccCounter?.counterValue || 0;
    const totalDeclarations = totalDeclCounter?.counterValue || 0;
    const declarerStats: DeclarerStats[] = declarerStatsCounter?.metadata
      ? JSON.parse(declarerStatsCounter.metadata)
      : [];
    const lastCalculated = lastCalcCounter?.counterValue || 0;

    return {
      totalUniqueIscc,
      totalDeclarations,
      declarerStats,
      lastCalculated,
    };
  } catch (error) {
    console.error("Error getting current analytics data:", error);
    throw error;
  }
}

/**
 * Handle new declaration - update real-time counters
 */
export async function handleNewDeclaration(
  declarerId: string,
  isccCode: string,
  isNewUniqueIscc: boolean = true,
): Promise<void> {
  try {
    console.log(`Handling new declaration: declarerId=${declarerId}, iscc=${isccCode}, isNew=${isNewUniqueIscc}`);

    // Always increment total declarations counter
    await incrementAnalyticsCounter(COUNTER_KEYS.TOTAL_DECLARATIONS, 1);

    // Update declarer-specific total declarations counter
    const declarerTotalKey = `declarer_${declarerId}_total_declarations`;
    await incrementAnalyticsCounter(declarerTotalKey, 1);

    if (isNewUniqueIscc) {
      // Increment total unique ISCC counter
      await incrementAnalyticsCounter(COUNTER_KEYS.TOTAL_UNIQUE_ISCC, 1);

      // Update declarer-specific unique ISCC counters
      const declarerUniqueKey = `declarer_${declarerId}_unique_iscc`;
      await incrementAnalyticsCounter(declarerUniqueKey, 1);

      console.log(`Updated counters for new unique ISCC: ${isccCode} by ${declarerId}`);
    } else {
      console.log(`Updated counters for duplicate ISCC: ${isccCode} by ${declarerId}`);
    }
  } catch (error) {
    console.error("Error handling new declaration:", error);
    // Don't throw error to avoid disrupting main flow
  }
}

// Simple in-memory cache for ISCC codes (will reset on function cold start)
const isccCodeCache = new Set<string>();
const cacheMaxSize = 10000; // Limit cache size to prevent memory issues
let cacheLastClear = Date.now();
const cacheClearInterval = 60 * 60 * 1000; // Clear cache every hour

/**
 * Check if an ISCC code already exists for any declarer
 * Uses a simple in-memory cache for performance
 */
export async function isNewUniqueIsccCode(isccCode: string): Promise<boolean> {
  // Clear cache periodically to prevent stale data
  const now = Date.now();
  if (now - cacheLastClear > cacheClearInterval) {
    console.log("Clearing ISCC code cache for freshness");
    isccCodeCache.clear();
    cacheLastClear = now;
  }

  // Limit cache size
  if (isccCodeCache.size >= cacheMaxSize) {
    console.log("ISCC code cache at max size, clearing oldest entries");
    isccCodeCache.clear();
  }

  // Check if we've seen this ISCC code before
  if (isccCodeCache.has(isccCode)) {
    return false; // Not new, we've seen it
  }

  // Add to cache and assume it's new
  isccCodeCache.add(isccCode);

  // For better accuracy, we could check DynamoDB here, but that would add latency
  // The periodic recalculation ensures eventual consistency
  return true;
}

/**
 * Clear the ISCC code cache (useful for testing or after recalculation)
 */
export function clearIsccCodeCache(): void {
  isccCodeCache.clear();
  cacheLastClear = Date.now();
  console.log("ISCC code cache cleared manually");
}

/**
 * Get fast analytics data (from counters)
 */
export async function getFastAnalyticsData(): Promise<{
  totalUniqueIscc: number;
  totalDeclarations: number;
  declarerStats: DeclarerStats[];
  lastUpdated: number;
  dataSource: "realtime" | "calculated";
}> {
  try {
    const data = await getCurrentAnalyticsData();

    return {
      totalUniqueIscc: data.totalUniqueIscc,
      totalDeclarations: data.totalDeclarations,
      declarerStats: data.declarerStats,
      lastUpdated: data.lastCalculated,
      dataSource: data.lastCalculated > 0 ? "calculated" : "realtime",
    };
  } catch (error) {
    console.error("Error getting fast analytics data:", error);
    throw error;
  }
}
