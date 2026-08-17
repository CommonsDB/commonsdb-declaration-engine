/**
 * Test configuration module
 * Mirrors the declarationUtils config pattern but for tests
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface TestConfig {
  apiBaseUrl: string;
  apiKey: string;
  privateKeyPath: string;
  publicKeyPath: string;
  declarerId: string;
  companyId: string;
  tsaUrl: string;
  isccCode: string;
}

// Base path for keys - check integration-tests folder first, then fall back to debug/testing
const integrationTestsPath = path.resolve(__dirname, "../..");
const testingPath = path.resolve(__dirname, "../../../debug/testing");

function getBasePath(): string {
  // Check if keys exist in integration-tests folder
  const localPrivateKey = path.resolve(integrationTestsPath, "./api_test_ec_private_key.pem");
  if (fs.existsSync(localPrivateKey)) {
    return integrationTestsPath;
  }
  // Fall back to testing folder
  return testingPath;
}

const testingBasePath = getBasePath();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} — copy env.template to .env and fill it in`);
  }
  return value;
}

export function getTestConfig(): TestConfig {
  const declarerId = requireEnv("DECLARER_ID");
  return {
    apiBaseUrl: requireEnv("API_BASE_URL"),
    apiKey: process.env.API_KEY || "",
    privateKeyPath: process.env.EC_PRIVATE_KEY_PATH || "./api_test_ec_private_key.pem",
    publicKeyPath: process.env.EC_PUBLIC_KEY_PATH || "./api_test_ec_public_key.pem",
    declarerId,
    companyId: process.env.COMPANY_ID || declarerId,
    tsaUrl: process.env.TSA_URL || "https://freetsa.org/tsr",
    isccCode: process.env.ISCC_CODE || "ISCC:KAC2IJRHGCFSOVKSFF36P3BQGZBMAETBFZIPBOTJR4UBEVIHTOIJMSY",
  };
}

export function loadPrivateKey(config: TestConfig): string {
  const keyPath = path.resolve(testingBasePath, config.privateKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key file not found at ${keyPath}`);
  }
  return fs.readFileSync(keyPath, "utf8");
}

export function loadPublicKey(config: TestConfig): string {
  const keyPath = path.resolve(testingBasePath, config.publicKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Public key file not found at ${keyPath}`);
  }
  return fs.readFileSync(keyPath, "utf8");
}

export function getPublicKeyJwk(publicKeyPem: string): crypto.JsonWebKey {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  return keyObject.export({ format: "jwk" });
}

export const testingBasePath$ = testingBasePath;
