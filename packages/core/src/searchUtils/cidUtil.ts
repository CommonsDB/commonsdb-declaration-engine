/**
 * Utilities for cidV1 generation and validation
 * This module provides functionality to generate Content Identifiers (CIDs) version 1
 * following the IPFS specifications.
 */

import { Buffer } from "buffer";
import baseX from "base-x";
import * as multihashes from "multihashes";
import { createHash } from "crypto";
import { IDeclarationPublicMetadata } from "../interfaces/commonInterfaces";

// Base32 alphabet used by IPFS
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = baseX(BASE32_ALPHABET);

// Interface for cidV1 generation options
interface CidV1Options {
  hashAlgorithm: multihashes.HashName;
  encoding: string;
}

// Interface for CID generation result
interface CidResult {
  cidV1: string;
}

// Default options for CIDv1 generation
const defaultV1Options: CidV1Options = {
  hashAlgorithm: "sha2-256",
  encoding: "base32",
};

/**
 * Serializes a JSON object with deterministic key ordering
 * @param jsonObj - Any JSON-serializable object
 * @returns Buffer containing the serialized JSON
 */
export function serializeJson(jsonObj: unknown): Buffer {
  // Sort keys to ensure deterministic serialization
  const jsonString = JSON.stringify(jsonObj, Object.keys(jsonObj as object).sort());
  return Buffer.from(jsonString, "utf-8");
}

/**
 * Creates a hash of serialized JSON data
 * @param serializedJson - Buffer containing serialized JSON
 * @param algorithm - Hash algorithm name (default: 'sha2-256')
 * @returns Buffer containing the hash
 */
export function hashSerializedJson(serializedJson: Buffer, algorithm: multihashes.HashName = "sha2-256"): Buffer {
  // Convert sha2-256 to sha256 for crypto module
  const cryptoAlgorithm = algorithm.replace("sha2-", "sha");
  const hash = createHash(cryptoAlgorithm);
  hash.update(serializedJson);
  return hash.digest();
}

/**
 * Generates a CIDv1 from a JSON object
 * @param jsonObj - Any JSON-serializable object
 * @param options - Optional CID generation configuration
 * @returns CIDResult containing the generated CID and metadata
 */
export function generateCidFromJson(
  jsonObj: IDeclarationPublicMetadata,
  options: CidV1Options = defaultV1Options,
): string {
  const serializedJson = serializeJson(jsonObj);
  const hashBytes = hashSerializedJson(serializedJson, options.hashAlgorithm);
  return createCidV1(hashBytes, options);
}

/**
 * Generates a CIDv1 from the provided data
 * @param hashBytes - Buffer containing the hash bytes
 * @param options - Optional configuration for CID generation
 * @returns CIDResult containing the generated CID and metadata
 */
export function createCidV1(hashBytes: Buffer, options: CidV1Options = defaultV1Options): string {
  // CIDv1 follows a different format than CIDv0:
  // - Uses base32 encoding by default
  // - Has a different multicodec prefix
  // - Includes content type information

  // 1. Create the multicodec prefix for CIDv1
  const cidV1Prefix = Buffer.from([0x01]); // Version 1 prefix

  // 2. Create content type identifier (e.g., for JSON)
  const contentTypePrefix = Buffer.from([0x0c]); // represents JSON content type

  // 3. Create the multihash
  const multihash = multihashes.encode(hashBytes, options.hashAlgorithm);

  // 4. Combine all components
  const cidBuffer = Buffer.concat([cidV1Prefix, contentTypePrefix, multihash]);

  // 5. Encode using base32
  const cidV1 = base32.encode(cidBuffer);

  return cidV1;
}

// Export types
export type { CidV1Options, CidResult };
