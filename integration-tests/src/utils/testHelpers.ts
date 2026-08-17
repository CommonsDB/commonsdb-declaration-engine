/**
 * Test helper functions
 */

import { TestConfig, loadPrivateKey, loadPublicKey } from "./testConfig";
import { ApiClient, createJwtSignature, getTimestamp, DeclarationPayload, TsaSignature } from "./apiClient";
import { DeclarationMetadata, TestCase, generateValidDeclarationMetadata } from "../fixtures/testData";

// ============================================================================
// Payload Building
// ============================================================================

/**
 * Build a complete declaration payload with signatures
 */
export async function buildDeclarationPayload(
  metadata: DeclarationMetadata,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
): Promise<DeclarationPayload> {
  const signaturePayload = {
    iscc: metadata.publicMetadata.iscc,
    name: metadata.publicMetadata.name,
    description: metadata.publicMetadata.description,
    mediatype: metadata.publicMetadata.mediatype,
    thumbnail: metadata.publicMetadata.thumbnail,
    sourceUrl: metadata.publicMetadata.sourceUrl,
    version: metadata.publicMetadata.version,
    timestamp: metadata.publicMetadata.timestamp,
    declarerId: metadata.publicMetadata.declarerId,
    credentials: metadata.publicMetadata.credentials,
    supplierMetadata: metadata.publicMetadata.supplierMetadata,
  };

  const signature = createJwtSignature(signaturePayload, privateKey, publicKey);
  const tsaSignature = await getTimestamp(signature, config.tsaUrl);

  const payload: DeclarationPayload = {
    declarationMetadata: metadata,
    signature,
    tsaSignature,
  };

  // Only add commonsDbRegistry signatures if commonsDbRegistry exists
  if (metadata.commonsDbRegistry) {
    const commonsDbRegistryPayload = { ...signaturePayload };
    const commonsDbRegistrySignature = createJwtSignature(commonsDbRegistryPayload, privateKey, publicKey);
    const commonsDbRegistryTsaSignature = await getTimestamp(commonsDbRegistrySignature, config.tsaUrl);

    payload.commonsDbRegistrySignature = commonsDbRegistrySignature;
    payload.commonsDbRegistryTsaSignature = commonsDbRegistryTsaSignature;
  }

  return payload;
}

/**
 * Build a payload with intentionally bad signatures (for testing signature verification)
 */
export async function buildPayloadWithBadSignature(
  metadata: DeclarationMetadata,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
): Promise<DeclarationPayload> {
  const payload = await buildDeclarationPayload(metadata, privateKey, publicKey, config);

  // Corrupt the signature
  payload.signature = payload.signature.slice(0, -10) + "CORRUPTED!";

  return payload;
}

/**
 * Build a payload with bad TSA signature
 */
export async function buildPayloadWithBadTsaSignature(
  metadata: DeclarationMetadata,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
): Promise<DeclarationPayload> {
  const payload = await buildDeclarationPayload(metadata, privateKey, publicKey, config);

  // Corrupt the TSA signature
  payload.tsaSignature.tsr = "INVALID_TSA_RESPONSE";

  return payload;
}

/**
 * Build a payload with mismatched TSA (TSA for different data)
 */
export async function buildPayloadWithMismatchedTsa(
  metadata: DeclarationMetadata,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
): Promise<DeclarationPayload> {
  const payload = await buildDeclarationPayload(metadata, privateKey, publicKey, config);

  // Get TSA for different data
  const wrongTsa = await getTimestamp("completely different data", config.tsaUrl);
  payload.tsaSignature = wrongTsa;

  return payload;
}

// ============================================================================
// Test Execution Helpers
// ============================================================================

export interface TestResult {
  testCase: TestCase;
  passed: boolean;
  actualSuccess: boolean;
  statusCode?: number;
  error?: string;
  errorData?: any;
  duration: number;
}

/**
 * Execute a single test case
 */
export async function executeTestCase(
  testCase: TestCase,
  apiClient: ApiClient,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Update timestamp to current time (unless we're testing old timestamps)
    const metadata = testCase.metadata as DeclarationMetadata;
    if (metadata.publicMetadata && !testCase.name.includes("timestamp")) {
      metadata.publicMetadata.timestamp = Date.now();
      if (metadata.commonsDbRegistry) {
        metadata.commonsDbRegistry.timestamp = Date.now();
      }
    }

    const payload = await buildDeclarationPayload(metadata, privateKey, publicKey, config);

    const response = await apiClient.submitDeclaration(payload);
    const duration = Date.now() - startTime;

    const actualSuccess = response.success;
    const passed = actualSuccess === testCase.expectSuccess;

    // If we expected failure but got success, or vice versa
    if (!passed) {
      console.log(
        `  [MISMATCH] Expected ${testCase.expectSuccess ? "success" : "failure"}, got ${actualSuccess ? "success" : "failure"}`,
      );
    }

    return {
      testCase,
      passed,
      actualSuccess,
      statusCode: response.statusCode,
      error: response.error,
      errorData: response.errorData,
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;

    // If we expected failure and got an exception, that counts as passing
    const passed = !testCase.expectSuccess;

    return {
      testCase,
      passed,
      actualSuccess: false,
      error: error.message,
      duration,
    };
  }
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Check if an error response contains expected error field
 */
export function errorContainsField(errorData: any, field: string): boolean {
  if (!errorData) return false;

  const errorString = JSON.stringify(errorData).toLowerCase();
  return errorString.includes(field.toLowerCase());
}

/**
 * Check if response indicates validation error
 */
export function isValidationError(statusCode?: number): boolean {
  return statusCode === 400 || statusCode === 422;
}

/**
 * Check if response indicates authentication error
 */
export function isAuthError(statusCode?: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

/**
 * Check if response indicates not found
 */
export function isNotFound(statusCode?: number): boolean {
  return statusCode === 404;
}

// ============================================================================
// Batch Processing
// ============================================================================

/**
 * Execute multiple test cases with delay between each
 */
export async function executeBatchTestCases(
  testCases: TestCase[],
  apiClient: ApiClient,
  privateKey: string,
  publicKey: string,
  config: TestConfig,
  delayMs: number = 500,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`  [${i + 1}/${testCases.length}] Running: ${testCase.name}`);

    const result = await executeTestCase(testCase, apiClient, privateKey, publicKey, config);
    results.push(result);

    // Add delay between tests to avoid rate limiting
    if (i < testCases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Summarize test results
 */
export function summarizeResults(results: TestResult[]): {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgDuration: number;
} {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const passRate = (passed / total) * 100;
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;

  return { total, passed, failed, passRate, avgDuration };
}

/**
 * Print detailed test summary
 */
export function printTestSummary(results: TestResult[]): void {
  const summary = summarizeResults(results);

  console.log("\n========================================");
  console.log("TEST SUMMARY");
  console.log("========================================");
  console.log(`Total Tests:    ${summary.total}`);
  console.log(`Passed:         ${summary.passed}`);
  console.log(`Failed:         ${summary.failed}`);
  console.log(`Pass Rate:      ${summary.passRate.toFixed(2)}%`);
  console.log(`Avg Duration:   ${summary.avgDuration.toFixed(0)}ms`);
  console.log("========================================\n");

  if (summary.failed > 0) {
    console.log("FAILED TESTS:");
    console.log("----------------------------------------");
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  ❌ ${r.testCase.name}`);
        console.log(`     Expected: ${r.testCase.expectSuccess ? "success" : "failure"}`);
        console.log(`     Actual:   ${r.actualSuccess ? "success" : "failure"}`);
        if (r.error) console.log(`     Error: ${r.error}`);
      });
    console.log("----------------------------------------\n");
  }
}

// ============================================================================
// Sleep/Delay Helpers
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(delay);
}
