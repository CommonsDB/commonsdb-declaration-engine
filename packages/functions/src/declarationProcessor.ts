import { Config } from "sst/node/config";
import { IDeclarationPayload } from "@commonsdb/core/interfaces/commonInterfaces";
import { processIsccStringRaw } from "@commonsdb/core/searchUtils/indexingUtils";
import { notifySlack } from "@commonsdb/core/searchUtils/notifyUtil";
import { getIdentifierKeyValuePair } from "@commonsdb/core/utils/fieldMapping";
import {
  updateDeclarationStatusSuccess,
  updateDeclarationStatusFailed,
} from "@commonsdb/core/searchUtils/tableDeclarationStatusUtil";
import { markAsSuperseded } from "@commonsdb/core/searchUtils/tableSupersededUtil";

// Maximum retries for status update before giving up
const MAX_STATUS_UPDATE_RETRIES = 3;
const STATUS_UPDATE_RETRY_DELAY_MS = 500;

/**
 * Kinesis stream handler that processes declaration records.
 * Uses partial batch response to report individual record failures.
 * This ensures Kinesis will retry only the failed records.
 */
export async function handler(_evt: any, _ctx: any) {
  console.log(Config.VERSION);
  console.log("Received event", "hasRecordsObject:", !!_evt.Records);
  console.log("records:", _evt.Records?.length || 0);

  // Track failed record sequence numbers for partial batch response
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (let i = 0; i < _evt.Records.length; i++) {
    const record = _evt.Records[i];
    console.log("Processing record:", i, "sequenceNumber:", record.kinesis?.sequenceNumber);

    try {
      await processSingleRecordFromIterator(record);
    } catch (err: any) {
      console.error("Error processing record:", i, err);

      // Add to failed batch items so Kinesis will retry this record
      batchItemFailures.push({
        itemIdentifier: record.kinesis.sequenceNumber,
      });

      // Notify about the failure (don't let this block the loop)
      try {
        await notifySlack(
          {
            message: "Declaration Handler Loop: Error processing record",
            env: Config.STAGE,
            error: err?.message || String(err),
            recordNumber: i,
            totalRecords: _evt.Records.length,
            sequenceNumber: record.kinesis?.sequenceNumber,
          },
          "error",
        );
      } catch (notifyErr) {
        console.error("Failed to notify Slack:", notifyErr);
      }
    }
  }

  // Return partial batch response
  // If batchItemFailures is empty, all records processed successfully
  // If it contains items, Kinesis will retry those specific records
  console.log(`Batch processing complete. Failures: ${batchItemFailures.length}/${_evt.Records.length}`);

  return {
    batchItemFailures,
  };
}

/**
 * Process a single record from the Kinesis stream.
 * Throws an error if processing fails to ensure proper retry behavior.
 */
async function processSingleRecordFromIterator(record: any): Promise<void> {
  const data = Buffer.from(record.kinesis.data as any, "base64").toString("utf8");
  const payload: IDeclarationPayload = JSON.parse(data);

  console.log("PROCESSOR: Received record:", payload.metaInternal.rayId || "MISSING_RAY_ID");

  // Get identifier for status tracking
  const [, fieldValue] = getIdentifierKeyValuePair(payload.metaInternal);
  const identifier = fieldValue || "";

  const isccCode = payload.declarationMetadata.publicMetadata?.iscc || "";
  const isMatch = isccCode.toUpperCase().match(/ISCC:[A-Z0-9]{55}/);

  if (isccCode === "" || !isMatch) {
    const errorMessage = `Invalid ISCC code format: ${isccCode}`;
    console.error("Error getting declarationMetadata.publicMetadata.iscc (not matching pattern) [", isccCode, "]");

    // Update status to failed if we have an identifier - this is a permanent failure, no retry needed
    if (identifier) {
      await updateStatusWithRetry(identifier, "failed", errorMessage);
    }

    // Don't throw - this is a validation error, not a processing error
    // The record should not be retried as the data is invalid
    return;
  }

  const companyId = payload.metaInternal.companyId;

  try {
    await processIsccStringRaw(isccCode, companyId, payload);

    // Update status to success after successful processing
    if (identifier) {
      await updateStatusWithRetry(identifier, "success");
      console.log("Updated declaration status to success for identifier:", identifier);
    }

    // Mark the superseded declaration if this declaration supersedes another
    const supersedes = (payload.declarationMetadata?.publicMetadata as any)?.supersedes;
    if (supersedes && typeof supersedes === "string" && supersedes.trim() !== "" && identifier) {
      try {
        console.log(`Marking declaration ${supersedes} as superseded by ${identifier}`);
        await markAsSuperseded(supersedes, identifier);
        console.log(`Successfully marked ${supersedes} as superseded by ${identifier}`);
      } catch (supersededError: any) {
        // Log the error but don't fail the processing - the declaration was still successfully indexed
        // The supersedes relationship is a secondary concern
        console.error("Failed to mark declaration as superseded (non-critical):", supersededError);
        try {
          await notifySlack(
            {
              message: "Warning: Failed to mark declaration as superseded",
              env: Config.STAGE,
              supersedes,
              supersedingIdentifier: identifier,
              error: supersededError?.message || String(supersededError),
            },
            "warning",
          );
        } catch (notifyErr) {
          console.error("Failed to notify Slack:", notifyErr);
        }
      }
    }
  } catch (processingError: any) {
    const errorMessage = processingError?.message || "Unknown processing error";
    console.error("Error processing declaration:", errorMessage);

    // Update status to failed
    if (identifier) {
      await updateStatusWithRetry(identifier, "failed", errorMessage);
      console.log("Updated declaration status to failed for identifier:", identifier);
    }

    // Re-throw to signal the record failed and should be added to batchItemFailures
    throw processingError;
  }
}

/**
 * Update declaration status with retry logic.
 * This is critical - if we can't update the status, we need to throw to ensure the record is retried.
 */
async function updateStatusWithRetry(
  identifier: string,
  status: "success" | "failed",
  errorMessage?: string,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_STATUS_UPDATE_RETRIES; attempt++) {
    try {
      if (status === "success") {
        await updateDeclarationStatusSuccess(identifier);
      } else {
        await updateDeclarationStatusFailed(identifier, errorMessage || "Processing failed");
      }
      return; // Success, exit the retry loop
    } catch (err: any) {
      lastError = err;
      console.error(`Failed to update declaration status (attempt ${attempt}/${MAX_STATUS_UPDATE_RETRIES}):`, err);

      if (attempt < MAX_STATUS_UPDATE_RETRIES) {
        // Wait before retrying with exponential backoff
        await new Promise((resolve) => setTimeout(resolve, STATUS_UPDATE_RETRY_DELAY_MS * attempt));
      }
    }
  }

  // All retries failed - this is critical, throw to ensure the record will be retried by Kinesis
  const criticalError = new Error(
    `CRITICAL: Failed to update declaration status to '${status}' for identifier '${identifier}' after ${MAX_STATUS_UPDATE_RETRIES} attempts. ` +
      `Original error: ${lastError?.message || "Unknown error"}`,
  );

  // Notify about critical failure
  try {
    await notifySlack(
      {
        message: "CRITICAL: Failed to update declaration status after retries",
        env: Config.STAGE,
        identifier,
        targetStatus: status,
        errorMessage: errorMessage || "N/A",
        lastError: lastError?.message || "Unknown",
        attempts: MAX_STATUS_UPDATE_RETRIES,
      },
      "error",
    );
  } catch (notifyErr) {
    console.error("Failed to notify Slack about critical status update failure:", notifyErr);
  }

  throw criticalError;
}
