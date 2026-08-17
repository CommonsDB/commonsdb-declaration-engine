/**
 * Jest setup file
 * Loads environment variables from the local .env file
 */

import * as fs from "fs";
import * as path from "path";

// Load .env file from integration-tests folder first, fall back to testing folder
const localEnvPath = path.resolve(__dirname, "../.env");
const testingEnvPath = path.resolve(__dirname, "../../debug/testing/.env");

function loadEnvFile(envPath: string): boolean {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          process.env[key.trim()] = valueParts.join("=").trim();
        }
      }
    });
    console.log(`[Test Setup] Loaded environment from: ${envPath}`);
    return true;
  }
  return false;
}

// Try local .env first, then fall back to testing folder
if (!loadEnvFile(localEnvPath)) {
  if (!loadEnvFile(testingEnvPath)) {
    console.warn(`[Test Setup] Warning: No .env file found. Please copy env.template to .env`);
  }
}

// Set test timeouts
jest.setTimeout(120000); // 2 minutes for API calls

// Global test hooks
beforeAll(async () => {
  console.log("\n=== CommonsDB Integration Tests Starting ===\n");
  console.log(`API Base URL: ${process.env.API_BASE_URL || "(unset — set API_BASE_URL in .env)"}`);
});

afterAll(async () => {
  console.log("\n=== CommonsDB Integration Tests Complete ===\n");
});
