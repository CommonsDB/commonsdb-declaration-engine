import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { sendRecord } from "@commonsdb/core/producer/produce";
import {
  IDeclarationPayload,
  IDeclarationPublicMetadata,
  IDeclarationCommonsDbRegistry,
} from "@commonsdb/core/interfaces/commonInterfaces";
import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import axios from "axios";
import { getIdentifierKeyValuePair, IdentifierFieldValuesType } from "@commonsdb/core/utils/fieldMapping";
import { initializeMetaInternal } from "@commonsdb/core/utils/declarationUtils";
import { createPendingDeclarationStatus } from "@commonsdb/core/searchUtils/tableDeclarationStatusUtil";
import { parseTSQ, parseTSR } from "@commonsdb/core/utils/tsaCryptoUtil";
import { validateSupersedes } from "@commonsdb/core/searchUtils/tableSupersededUtil";

// Cache for fetched schemas and contexts to avoid repeated downloads
const schemaCache: Map<string, object> = new Map();
const contextCache: Map<string, object> = new Map();

// Minimum required schema version
const MIN_SCHEMA_VERSION = "0.2.0";

// Schema URL pattern: https://w3id.org/commonsdb/schema/X.X.X.json
const SCHEMA_URL_PATTERN = /^https:\/\/w3id\.org\/commonsdb\/schema\/(\d+\.\d+\.\d+)\.json$/;
const CONTEXT_URL_PATTERN = /^https:\/\/w3id\.org\/commonsdb\/context\/(\d+\.\d+\.\d+)\.json$/;

/**
 * Compare semantic versions
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Validate schema/context URL pattern and version
 */
function validateSchemaUrl(
  url: string,
  type: "schema" | "context",
): { valid: boolean; version?: string; error?: string } {
  const pattern = type === "schema" ? SCHEMA_URL_PATTERN : CONTEXT_URL_PATTERN;
  const match = url.match(pattern);

  if (!match) {
    return {
      valid: false,
      error: `Invalid ${type} URL format. Expected: https://w3id.org/commonsdb/${type}/X.X.X.json`,
    };
  }

  const version = match[1];

  if (compareVersions(version, MIN_SCHEMA_VERSION) < 0) {
    return {
      valid: false,
      version,
      error: `${type} version ${version} is not supported. Minimum required version is ${MIN_SCHEMA_VERSION}`,
    };
  }

  return { valid: true, version };
}

// Local fallback schema (v0.2.0) - used when external fetch fails
const LOCAL_SCHEMA_VERSION = "0.2.0";
const LOCAL_SCHEMA: object = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://w3id.org/commonsdb/schema/0.2.0.json",
  title: "CommonsDB Declaration Schema 0.2.0",
  type: "object",
  required: ["signature", "tsaSignature", "declarationMetadata"],
  properties: {
    signature: { type: "string", pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" },
    tsaSignature: { type: "object", required: ["tsr", "tsq"] },
    commonsDbRegistrySignature: { type: "string" },
    commonsDbRegistryTsaSignature: { type: "object" },
    declarationMetadata: { type: "object", required: ["publicMetadata"] },
  },
  $defs: {
    PublicMetadata: {
      type: "object",
      required: ["$schema", "@context", "iscc", "name", "timestamp", "declarerId", "credentials"],
      properties: {
        $schema: { type: "string", format: "uri" },
        "@context": { type: "string", format: "uri" },
        iscc: { type: "string", pattern: "^ISCC:[A-Z0-9]{4,}$" },
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        mediatype: { type: "string" },
        thumbnail: { type: "string" },
        sourceUrl: { type: "string", format: "uri" },
        version: { type: "integer", minimum: 1 },
        timestamp: { type: "integer" },
        declarerId: { type: "string", pattern: "^did:[a-z0-9]+:" },
        credentials: { type: "array", minItems: 1 },
        supplierMetadata: { type: "object" },
      },
    },
    CommonsDbRegistry: {
      type: "object",
      required: ["iscc", "location", "rightsStatement", "timestamp", "credentials"],
      properties: {
        iscc: { type: "string", pattern: "^ISCC:[A-Z0-9]{4,}$" },
        location: { type: "string", format: "uri" },
        rightsStatement: { type: "string", format: "uri" },
        timestamp: { type: "integer" },
        credentials: { type: "array", minItems: 1 },
      },
    },
  },
};

// Local fallback context for CommonsDB (v0.2.0) - used when external fetch fails
const LOCAL_CONTEXT: object = {
  "@context": {
    "@version": 1.1,
    xsd: "http://www.w3.org/2001/XMLSchema#",
    dct: "http://purl.org/dc/terms/",
    schema: "https://schema.org/",
    commonsdb: "https://w3id.org/commonsdb/ont/",
    iscc: { "@id": "https://schema.iscc.codes/terms/iscc", "@type": "xsd:string" },
    name: { "@id": "dct:title", "@type": "xsd:string" },
    description: { "@id": "dct:description", "@type": "xsd:string" },
    timestamp: { "@id": "http://www.w3.org/ns/prov#generatedAtTime", "@type": "xsd:integer" },
    location: { "@id": "schema:contentUrl", "@type": "@id" },
    rightsStatement: { "@id": "dct:rights", "@type": "@id" },
    declarerId: { "@id": "commonsdb:declarerId", "@type": "xsd:string" },
    credentials: { "@id": "https://www.w3.org/2018/credentials/#verifiableCredential", "@type": "@id" },
  },
};

// Allowed rights statement values (Public Domain + CC BY/BY-SA licenses)
const allowedRightsStatements = new Set([
  // Public Domain
  "https://creativecommons.org/publicdomain/mark/1.0/",
  "https://creativecommons.org/publicdomain/zero/1.0/",
  // CC BY 1.0
  "https://creativecommons.org/licenses/by/1.0/",
  "https://creativecommons.org/licenses/by/1.0/fi/",
  "https://creativecommons.org/licenses/by/1.0/il/",
  "https://creativecommons.org/licenses/by/1.0/nl/",
  // CC BY 2.0
  "https://creativecommons.org/licenses/by/2.0/",
  "https://creativecommons.org/licenses/by/2.0/au/",
  "https://creativecommons.org/licenses/by/2.0/at/",
  "https://creativecommons.org/licenses/by/2.0/be/",
  "https://creativecommons.org/licenses/by/2.0/br/",
  "https://creativecommons.org/licenses/by/2.0/ca/",
  "https://creativecommons.org/licenses/by/2.0/cl/",
  "https://creativecommons.org/licenses/by/2.0/hr/",
  "https://creativecommons.org/licenses/by/2.0/fr/",
  "https://creativecommons.org/licenses/by/2.0/de/",
  "https://creativecommons.org/licenses/by/2.0/it/",
  "https://creativecommons.org/licenses/by/2.0/jp/",
  "https://creativecommons.org/licenses/by/2.0/kr/",
  "https://creativecommons.org/licenses/by/2.0/nl/",
  "https://creativecommons.org/licenses/by/2.0/pl/",
  "https://creativecommons.org/licenses/by/2.0/za/",
  "https://creativecommons.org/licenses/by/2.0/es/",
  "https://creativecommons.org/licenses/by/2.0/tw/",
  "https://creativecommons.org/licenses/by/2.0/uk/",
  // CC BY 2.1
  "https://creativecommons.org/licenses/by/2.1/au/",
  "https://creativecommons.org/licenses/by/2.1/ca/",
  "https://creativecommons.org/licenses/by/2.1/jp/",
  "https://creativecommons.org/licenses/by/2.1/es/",
  // CC BY 2.5
  "https://creativecommons.org/licenses/by/2.5/",
  "https://creativecommons.org/licenses/by/2.5/ar/",
  "https://creativecommons.org/licenses/by/2.5/au/",
  "https://creativecommons.org/licenses/by/2.5/br/",
  "https://creativecommons.org/licenses/by/2.5/bg/",
  "https://creativecommons.org/licenses/by/2.5/ca/",
  "https://creativecommons.org/licenses/by/2.5/cn/",
  "https://creativecommons.org/licenses/by/2.5/co/",
  "https://creativecommons.org/licenses/by/2.5/hr/",
  "https://creativecommons.org/licenses/by/2.5/dk/",
  "https://creativecommons.org/licenses/by/2.5/hu/",
  "https://creativecommons.org/licenses/by/2.5/in/",
  "https://creativecommons.org/licenses/by/2.5/il/",
  "https://creativecommons.org/licenses/by/2.5/it/",
  "https://creativecommons.org/licenses/by/2.5/mk/",
  "https://creativecommons.org/licenses/by/2.5/my/",
  "https://creativecommons.org/licenses/by/2.5/mt/",
  "https://creativecommons.org/licenses/by/2.5/mx/",
  "https://creativecommons.org/licenses/by/2.5/nl/",
  "https://creativecommons.org/licenses/by/2.5/pe/",
  "https://creativecommons.org/licenses/by/2.5/pl/",
  "https://creativecommons.org/licenses/by/2.5/pt/",
  "https://creativecommons.org/licenses/by/2.5/si/",
  "https://creativecommons.org/licenses/by/2.5/za/",
  "https://creativecommons.org/licenses/by/2.5/es/",
  "https://creativecommons.org/licenses/by/2.5/se/",
  "https://creativecommons.org/licenses/by/2.5/ch/",
  "https://creativecommons.org/licenses/by/2.5/tw/",
  "https://creativecommons.org/licenses/by/2.5/scotland/",
  // CC BY 3.0
  "https://creativecommons.org/licenses/by/3.0/",
  "https://creativecommons.org/licenses/by/3.0/am/",
  "https://creativecommons.org/licenses/by/3.0/au/",
  "https://creativecommons.org/licenses/by/3.0/at/",
  "https://creativecommons.org/licenses/by/3.0/az/",
  "https://creativecommons.org/licenses/by/3.0/br/",
  "https://creativecommons.org/licenses/by/3.0/ca/",
  "https://creativecommons.org/licenses/by/3.0/cl/",
  "https://creativecommons.org/licenses/by/3.0/cn/",
  "https://creativecommons.org/licenses/by/3.0/cr/",
  "https://creativecommons.org/licenses/by/3.0/hr/",
  "https://creativecommons.org/licenses/by/3.0/cz/",
  "https://creativecommons.org/licenses/by/3.0/ec/",
  "https://creativecommons.org/licenses/by/3.0/eg/",
  "https://creativecommons.org/licenses/by/3.0/ee/",
  "https://creativecommons.org/licenses/by/3.0/fr/",
  "https://creativecommons.org/licenses/by/3.0/ge/",
  "https://creativecommons.org/licenses/by/3.0/de/",
  "https://creativecommons.org/licenses/by/3.0/gr/",
  "https://creativecommons.org/licenses/by/3.0/gt/",
  "https://creativecommons.org/licenses/by/3.0/hk/",
  "https://creativecommons.org/licenses/by/3.0/ie/",
  "https://creativecommons.org/licenses/by/3.0/igo/",
  "https://creativecommons.org/licenses/by/3.0/it/",
  "https://creativecommons.org/licenses/by/3.0/lu/",
  "https://creativecommons.org/licenses/by/3.0/nl/",
  "https://creativecommons.org/licenses/by/3.0/nz/",
  "https://creativecommons.org/licenses/by/3.0/no/",
  "https://creativecommons.org/licenses/by/3.0/ph/",
  "https://creativecommons.org/licenses/by/3.0/pl/",
  "https://creativecommons.org/licenses/by/3.0/pt/",
  "https://creativecommons.org/licenses/by/3.0/pr/",
  "https://creativecommons.org/licenses/by/3.0/ro/",
  "https://creativecommons.org/licenses/by/3.0/rs/",
  "https://creativecommons.org/licenses/by/3.0/sg/",
  "https://creativecommons.org/licenses/by/3.0/za/",
  "https://creativecommons.org/licenses/by/3.0/es/",
  "https://creativecommons.org/licenses/by/3.0/ch/",
  "https://creativecommons.org/licenses/by/3.0/tw/",
  "https://creativecommons.org/licenses/by/3.0/th/",
  "https://creativecommons.org/licenses/by/3.0/ug/",
  "https://creativecommons.org/licenses/by/3.0/us/",
  "https://creativecommons.org/licenses/by/3.0/ve/",
  "https://creativecommons.org/licenses/by/3.0/vn/",
  // CC BY 4.0
  "https://creativecommons.org/licenses/by/4.0/",
  // CC BY-SA 1.0
  "https://creativecommons.org/licenses/by-sa/1.0/",
  "https://creativecommons.org/licenses/by-sa/1.0/fi/",
  "https://creativecommons.org/licenses/by-sa/1.0/il/",
  "https://creativecommons.org/licenses/by-sa/1.0/nl/",
  // CC BY-SA 2.0
  "https://creativecommons.org/licenses/by-sa/2.0/",
  "https://creativecommons.org/licenses/by-sa/2.0/au/",
  "https://creativecommons.org/licenses/by-sa/2.0/at/",
  "https://creativecommons.org/licenses/by-sa/2.0/be/",
  "https://creativecommons.org/licenses/by-sa/2.0/br/",
  "https://creativecommons.org/licenses/by-sa/2.0/ca/",
  "https://creativecommons.org/licenses/by-sa/2.0/cl/",
  "https://creativecommons.org/licenses/by-sa/2.0/hr/",
  "https://creativecommons.org/licenses/by-sa/2.0/fr/",
  "https://creativecommons.org/licenses/by-sa/2.0/de/",
  "https://creativecommons.org/licenses/by-sa/2.0/it/",
  "https://creativecommons.org/licenses/by-sa/2.0/jp/",
  "https://creativecommons.org/licenses/by-sa/2.0/kr/",
  "https://creativecommons.org/licenses/by-sa/2.0/nl/",
  "https://creativecommons.org/licenses/by-sa/2.0/pl/",
  "https://creativecommons.org/licenses/by-sa/2.0/za/",
  "https://creativecommons.org/licenses/by-sa/2.0/es/",
  "https://creativecommons.org/licenses/by-sa/2.0/tw/",
  "https://creativecommons.org/licenses/by-sa/2.0/uk/",
  // CC BY-SA 2.1
  "https://creativecommons.org/licenses/by-sa/2.1/au/",
  "https://creativecommons.org/licenses/by-sa/2.1/ca/",
  "https://creativecommons.org/licenses/by-sa/2.1/jp/",
  "https://creativecommons.org/licenses/by-sa/2.1/es/",
  // CC BY-SA 2.5
  "https://creativecommons.org/licenses/by-sa/2.5/",
  "https://creativecommons.org/licenses/by-sa/2.5/ar/",
  "https://creativecommons.org/licenses/by-sa/2.5/au/",
  "https://creativecommons.org/licenses/by-sa/2.5/br/",
  "https://creativecommons.org/licenses/by-sa/2.5/bg/",
  "https://creativecommons.org/licenses/by-sa/2.5/ca/",
  "https://creativecommons.org/licenses/by-sa/2.5/cn/",
  "https://creativecommons.org/licenses/by-sa/2.5/co/",
  "https://creativecommons.org/licenses/by-sa/2.5/hr/",
  "https://creativecommons.org/licenses/by-sa/2.5/dk/",
  "https://creativecommons.org/licenses/by-sa/2.5/hu/",
  "https://creativecommons.org/licenses/by-sa/2.5/in/",
  "https://creativecommons.org/licenses/by-sa/2.5/il/",
  "https://creativecommons.org/licenses/by-sa/2.5/it/",
  "https://creativecommons.org/licenses/by-sa/2.5/mk/",
  "https://creativecommons.org/licenses/by-sa/2.5/my/",
  "https://creativecommons.org/licenses/by-sa/2.5/mt/",
  "https://creativecommons.org/licenses/by-sa/2.5/mx/",
  "https://creativecommons.org/licenses/by-sa/2.5/nl/",
  "https://creativecommons.org/licenses/by-sa/2.5/pe/",
  "https://creativecommons.org/licenses/by-sa/2.5/pl/",
  "https://creativecommons.org/licenses/by-sa/2.5/pt/",
  "https://creativecommons.org/licenses/by-sa/2.5/si/",
  "https://creativecommons.org/licenses/by-sa/2.5/za/",
  "https://creativecommons.org/licenses/by-sa/2.5/es/",
  "https://creativecommons.org/licenses/by-sa/2.5/se/",
  "https://creativecommons.org/licenses/by-sa/2.5/ch/",
  "https://creativecommons.org/licenses/by-sa/2.5/tw/",
  "https://creativecommons.org/licenses/by-sa/2.5/scotland/",
  // CC BY-SA 3.0
  "https://creativecommons.org/licenses/by-sa/3.0/",
  "https://creativecommons.org/licenses/by-sa/3.0/am/",
  "https://creativecommons.org/licenses/by-sa/3.0/au/",
  "https://creativecommons.org/licenses/by-sa/3.0/at/",
  "https://creativecommons.org/licenses/by-sa/3.0/az/",
  "https://creativecommons.org/licenses/by-sa/3.0/br/",
  "https://creativecommons.org/licenses/by-sa/3.0/ca/",
  "https://creativecommons.org/licenses/by-sa/3.0/cl/",
  "https://creativecommons.org/licenses/by-sa/3.0/cn/",
  "https://creativecommons.org/licenses/by-sa/3.0/cr/",
  "https://creativecommons.org/licenses/by-sa/3.0/hr/",
  "https://creativecommons.org/licenses/by-sa/3.0/cz/",
  "https://creativecommons.org/licenses/by-sa/3.0/ec/",
  "https://creativecommons.org/licenses/by-sa/3.0/eg/",
  "https://creativecommons.org/licenses/by-sa/3.0/ee/",
  "https://creativecommons.org/licenses/by-sa/3.0/fr/",
  "https://creativecommons.org/licenses/by-sa/3.0/ge/",
  "https://creativecommons.org/licenses/by-sa/3.0/de/",
  "https://creativecommons.org/licenses/by-sa/3.0/gr/",
  "https://creativecommons.org/licenses/by-sa/3.0/gt/",
  "https://creativecommons.org/licenses/by-sa/3.0/hk/",
  "https://creativecommons.org/licenses/by-sa/3.0/igo/",
  "https://creativecommons.org/licenses/by-sa/3.0/it/",
  "https://creativecommons.org/licenses/by-sa/3.0/ie/",
  "https://creativecommons.org/licenses/by-sa/3.0/lu/",
  "https://creativecommons.org/licenses/by-sa/3.0/nl/",
  "https://creativecommons.org/licenses/by-sa/3.0/nz/",
  "https://creativecommons.org/licenses/by-sa/3.0/no/",
  "https://creativecommons.org/licenses/by-sa/3.0/ph/",
  "https://creativecommons.org/licenses/by-sa/3.0/pl/",
  "https://creativecommons.org/licenses/by-sa/3.0/pt/",
  "https://creativecommons.org/licenses/by-sa/3.0/pr/",
  "https://creativecommons.org/licenses/by-sa/3.0/ro/",
  "https://creativecommons.org/licenses/by-sa/3.0/rs/",
  "https://creativecommons.org/licenses/by-sa/3.0/sg/",
  "https://creativecommons.org/licenses/by-sa/3.0/za/",
  "https://creativecommons.org/licenses/by-sa/3.0/es/",
  "https://creativecommons.org/licenses/by-sa/3.0/ch/",
  "https://creativecommons.org/licenses/by-sa/3.0/tw/",
  "https://creativecommons.org/licenses/by-sa/3.0/th/",
  "https://creativecommons.org/licenses/by-sa/3.0/ug/",
  "https://creativecommons.org/licenses/by-sa/3.0/us/",
  "https://creativecommons.org/licenses/by-sa/3.0/ve/",
  "https://creativecommons.org/licenses/by-sa/3.0/vn/",
  // CC BY-SA 4.0
  "https://creativecommons.org/licenses/by-sa/4.0/",
]);

/**
 * Validates if a rightsStatement is one of the allowed values
 */
function isValidRightsStatement(rightsStatement: string): boolean {
  return allowedRightsStatements.has(rightsStatement);
}

interface ValidationResult {
  valid: boolean;
  errors?: string[];
  schemaVersion?: string;
  contextVersion?: string;
}

interface SchemaProperty {
  type?: string | string[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: any[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | SchemaProperty;
}

interface JsonSchema {
  $id?: string;
  $schema?: string;
  title?: string;
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | SchemaProperty;
}

/**
 * Validates if a string is a valid URL
 */
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates if a string matches a given pattern
 */
function matchesPattern(value: string, pattern: string): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(value);
  } catch {
    return false;
  }
}

/**
 * Validates a value against a schema property definition
 */
function validateValue(value: any, property: SchemaProperty, path: string): string[] {
  const errors: string[] = [];

  if (value === undefined || value === null) {
    return errors; // Undefined/null values are handled by required check
  }

  // Handle type validation
  if (property.type) {
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const actualType = Array.isArray(value) ? "array" : typeof value;

    let typeValid = false;
    for (const expectedType of types) {
      if (expectedType === "integer") {
        typeValid = typeof value === "number" && Number.isInteger(value);
      } else if (expectedType === "number") {
        typeValid = typeof value === "number";
      } else if (expectedType === "array") {
        typeValid = Array.isArray(value);
      } else if (expectedType === "object") {
        typeValid = typeof value === "object" && !Array.isArray(value) && value !== null;
      } else if (expectedType === "null") {
        typeValid = value === null;
      } else {
        typeValid = actualType === expectedType;
      }
      if (typeValid) break;
    }

    if (!typeValid) {
      errors.push(`${path}: expected type ${types.join(" or ")}, got ${actualType}`);
      return errors; // Don't continue validation if type is wrong
    }
  }

  // String validations
  if (typeof value === "string") {
    if (property.minLength !== undefined && value.length < property.minLength) {
      errors.push(`${path}: string length ${value.length} is less than minimum ${property.minLength}`);
    }
    if (property.maxLength !== undefined && value.length > property.maxLength) {
      errors.push(`${path}: string length ${value.length} exceeds maximum ${property.maxLength}`);
    }
    if (property.pattern && !matchesPattern(value, property.pattern)) {
      errors.push(`${path}: value does not match pattern ${property.pattern}`);
    }
    if (property.format) {
      switch (property.format) {
        case "uri":
        case "url":
          if (!isValidUrl(value)) {
            errors.push(`${path}: value is not a valid URL`);
          }
          break;
        case "email":
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.push(`${path}: value is not a valid email`);
          }
          break;
        case "date-time":
          if (isNaN(Date.parse(value))) {
            errors.push(`${path}: value is not a valid date-time`);
          }
          break;
        case "date":
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
            errors.push(`${path}: value is not a valid date`);
          }
          break;
      }
    }
  }

  // Number validations
  if (typeof value === "number") {
    if (property.minimum !== undefined && value < property.minimum) {
      errors.push(`${path}: value ${value} is less than minimum ${property.minimum}`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      errors.push(`${path}: value ${value} exceeds maximum ${property.maximum}`);
    }
  }

  // Enum validation
  if (property.enum && !property.enum.includes(value)) {
    errors.push(`${path}: value must be one of ${JSON.stringify(property.enum)}`);
  }

  // Array validation
  if (Array.isArray(value) && property.items) {
    value.forEach((item, index) => {
      const itemErrors = validateValue(item, property.items!, `${path}[${index}]`);
      errors.push(...itemErrors);
    });
  }

  // Object validation
  if (typeof value === "object" && !Array.isArray(value) && value !== null && property.properties) {
    // Validate required properties
    if (property.required) {
      for (const reqProp of property.required) {
        if (value[reqProp] === undefined || value[reqProp] === null) {
          errors.push(`${path}.${reqProp}: required property is missing`);
        }
      }
    }

    // Validate each property
    for (const [propName, propSchema] of Object.entries(property.properties)) {
      if (value[propName] !== undefined) {
        const propErrors = validateValue(value[propName], propSchema, `${path}.${propName}`);
        errors.push(...propErrors);
      }
    }
  }

  return errors;
}

/**
 * Validates data against a JSON schema without external libraries
 */
function validateAgainstJsonSchema(
  data: any,
  schema: JsonSchema,
  dataName: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  console.log(
    `[Schema Validation] Validating ${dataName} against schema: ${schema.title || schema["$id"] || "Unknown"}`,
  );

  // Check required properties at root level
  if (schema.required) {
    for (const reqProp of schema.required) {
      if (data[reqProp] === undefined || data[reqProp] === null) {
        errors.push(`${dataName}.${reqProp}: required property is missing`);
      }
    }
  }

  // Validate each property defined in schema
  if (schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (data[propName] !== undefined) {
        const propErrors = validateValue(data[propName], propSchema, `${dataName}.${propName}`);
        errors.push(...propErrors);
      }
    }
  }

  if (errors.length === 0) {
    console.log(`[Schema Validation] ${dataName} validation PASSED`);
  } else {
    console.error(`[Schema Validation] ${dataName} validation FAILED with ${errors.length} error(s)`);
    errors.forEach((err) => console.error(`[Schema Validation] Error: ${err}`));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates publicMetadata against built-in rules based on IDeclarationPublicMetadata interface
 */
function validatePublicMetadataStructure(publicMetadata: IDeclarationPublicMetadata): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  console.log(`[Schema Validation] Validating publicMetadata structure...`);
  console.log(`[Schema Validation] publicMetadata fields present: ${Object.keys(publicMetadata).join(", ")}`);

  // Required fields validation
  const requiredStringFields: (keyof IDeclarationPublicMetadata)[] = ["declarerId", "@context", "$schema"];
  for (const field of requiredStringFields) {
    const value = publicMetadata[field];
    if (value === undefined || value === null) {
      errors.push(`publicMetadata.${field}: required property is missing`);
    } else if (typeof value !== "string") {
      errors.push(`publicMetadata.${field}: expected string, got ${typeof value}`);
    } else if (value.trim() === "") {
      errors.push(`publicMetadata.${field}: required property cannot be empty`);
    }
  }

  // Validate timestamp (required, must be number)
  if (publicMetadata.timestamp === undefined || publicMetadata.timestamp === null) {
    errors.push(`publicMetadata.timestamp: required property is missing`);
  } else if (typeof publicMetadata.timestamp !== "number") {
    errors.push(`publicMetadata.timestamp: expected number, got ${typeof publicMetadata.timestamp}`);
  } else if (!Number.isFinite(publicMetadata.timestamp)) {
    errors.push(`publicMetadata.timestamp: must be a finite number`);
  }

  // Validate URL fields
  if (
    publicMetadata["$schema"] &&
    typeof publicMetadata["$schema"] === "string" &&
    !isValidUrl(publicMetadata["$schema"])
  ) {
    errors.push(`publicMetadata.$schema: must be a valid URL`);
  }
  if (
    publicMetadata["@context"] &&
    typeof publicMetadata["@context"] === "string" &&
    !isValidUrl(publicMetadata["@context"])
  ) {
    errors.push(`publicMetadata.@context: must be a valid URL`);
  }

  // Optional string fields validation
  const optionalStringFields: (keyof IDeclarationPublicMetadata)[] = [
    "iscc",
    "name",
    "description",
    "mode",
    "filename",
    "mediatype",
    "thumbnail",
    "metahash",
    "entryUUID",
    "datahash",
    "license",
    "acquire",
    "redirect",
  ];
  for (const field of optionalStringFields) {
    const value = publicMetadata[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      errors.push(`publicMetadata.${field}: expected string, got ${typeof value}`);
    }
  }

  // Optional numeric fields validation
  const optionalNumericFields: (keyof IDeclarationPublicMetadata)[] = ["filesize", "width", "height"];
  for (const field of optionalNumericFields) {
    const value = publicMetadata[field];
    if (value !== undefined && value !== null && typeof value !== "number") {
      errors.push(`publicMetadata.${field}: expected number, got ${typeof value}`);
    }
  }

  // Validate credentials as array (it's typed as string in interface but should be array for CommonsDB)
  const credentialsValue = (publicMetadata as any).credentials;
  if (credentialsValue !== undefined && credentialsValue !== null) {
    if (!Array.isArray(credentialsValue)) {
      errors.push(`publicMetadata.credentials: expected array, got ${typeof credentialsValue}`);
    } else if (credentialsValue.length === 0) {
      errors.push(`publicMetadata.credentials: array cannot be empty`);
    }
  }

  // Validate ISCC format if present
  if (publicMetadata.iscc && typeof publicMetadata.iscc === "string") {
    if (!publicMetadata.iscc.toUpperCase().match(/^ISCC:[A-Z0-9]{55}$/)) {
      errors.push(`publicMetadata.iscc: invalid ISCC format`);
    }
  }

  // Validate liccium_plugins if present
  if (publicMetadata.liccium_plugins !== undefined) {
    if (
      typeof publicMetadata.liccium_plugins !== "object" ||
      publicMetadata.liccium_plugins === null ||
      Array.isArray(publicMetadata.liccium_plugins)
    ) {
      errors.push(
        `publicMetadata.liccium_plugins: expected object, got ${Array.isArray(publicMetadata.liccium_plugins) ? "array" : typeof publicMetadata.liccium_plugins}`,
      );
    } else {
      const plugins = publicMetadata.liccium_plugins;

      // Validate iptcMetadata if present
      if (plugins.iptcMetadata !== undefined) {
        if (typeof plugins.iptcMetadata !== "object" || plugins.iptcMetadata === null) {
          errors.push(`publicMetadata.liccium_plugins.iptcMetadata: expected object`);
        } else {
          const iptc = plugins.iptcMetadata;
          if (iptc.digitalsourcetype !== undefined && typeof iptc.digitalsourcetype !== "string") {
            errors.push(`publicMetadata.liccium_plugins.iptcMetadata.digitalsourcetype: expected string`);
          }
          const iptcStringFields = [
            "keywords",
            "creator",
            "credit",
            "creditText",
            "copyrightNotice",
            "acquireLicensePage",
            "webstatementRights",
          ];
          for (const field of iptcStringFields) {
            const val = (iptc as any)[field];
            if (val !== undefined && typeof val !== "string") {
              errors.push(`publicMetadata.liccium_plugins.iptcMetadata.${field}: expected string`);
            }
          }
        }
      }

      // Validate tdmAiMetadata if present
      if (plugins.tdmAiMetadata !== undefined) {
        if (typeof plugins.tdmAiMetadata !== "object" || plugins.tdmAiMetadata === null) {
          errors.push(`publicMetadata.liccium_plugins.tdmAiMetadata: expected object`);
        } else {
          const tdm = plugins.tdmAiMetadata;
          if (tdm.TDMAI !== undefined && typeof tdm.TDMAI !== "boolean") {
            errors.push(`publicMetadata.liccium_plugins.tdmAiMetadata.TDMAI: expected boolean`);
          }
          if (tdm.TDMAI_policy_URL !== undefined && typeof tdm.TDMAI_policy_URL !== "string") {
            errors.push(`publicMetadata.liccium_plugins.tdmAiMetadata.TDMAI_policy_URL: expected string`);
          }
        }
      }

      // Validate c2paMetadata if present (basic structure check)
      if (plugins.c2paMetadata !== undefined) {
        if (typeof plugins.c2paMetadata !== "object" || plugins.c2paMetadata === null) {
          errors.push(`publicMetadata.liccium_plugins.c2paMetadata: expected object`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates commonsDbRegistry against built-in rules based on IDeclarationCommonsDbRegistry interface
 */
function validateCommonsDbRegistryStructure(commonsDbRegistry: IDeclarationCommonsDbRegistry): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  console.log(`[Schema Validation] Validating commonsDbRegistry structure...`);
  console.log(`[Schema Validation] commonsDbRegistry fields present: ${Object.keys(commonsDbRegistry).join(", ")}`);

  // Required string fields validation
  // NOTE: signature and commonsDbRegistryTsaSignature are at body level, NOT inside commonsDbRegistry
  const requiredStringFields: (keyof IDeclarationCommonsDbRegistry)[] = ["iscc", "location", "rightsStatement"];
  for (const field of requiredStringFields) {
    const value = commonsDbRegistry[field];
    if (value === undefined || value === null) {
      errors.push(`commonsDbRegistry.${field}: required property is missing`);
    } else if (typeof value !== "string") {
      errors.push(`commonsDbRegistry.${field}: expected string, got ${typeof value}`);
    } else if (value.trim() === "") {
      errors.push(`commonsDbRegistry.${field}: required property cannot be empty`);
    }
  }

  // Validate timestamp (required, must be number)
  if (commonsDbRegistry.timestamp === undefined || commonsDbRegistry.timestamp === null) {
    errors.push(`commonsDbRegistry.timestamp: required property is missing`);
  } else if (typeof commonsDbRegistry.timestamp !== "number") {
    errors.push(`commonsDbRegistry.timestamp: expected number, got ${typeof commonsDbRegistry.timestamp}`);
  } else if (!Number.isFinite(commonsDbRegistry.timestamp)) {
    errors.push(`commonsDbRegistry.timestamp: must be a finite number`);
  }

  // Validate ISCC format
  if (commonsDbRegistry.iscc && typeof commonsDbRegistry.iscc === "string") {
    if (!commonsDbRegistry.iscc.toUpperCase().match(/^ISCC:[A-Z0-9]{55}$/)) {
      errors.push(`commonsDbRegistry.iscc: invalid ISCC format`);
    }
  }

  // Validate location is a valid URL
  if (
    commonsDbRegistry.location &&
    typeof commonsDbRegistry.location === "string" &&
    !isValidUrl(commonsDbRegistry.location)
  ) {
    errors.push(`commonsDbRegistry.location: must be a valid URL`);
  }

  // Validate optional declarationId
  if (commonsDbRegistry.declarationId !== undefined && commonsDbRegistry.declarationId !== null) {
    if (typeof commonsDbRegistry.declarationId !== "string") {
      errors.push(`commonsDbRegistry.declarationId: expected string, got ${typeof commonsDbRegistry.declarationId}`);
    }
  }

  // Validate credentials array (cast to any for runtime validation since interface defines tuple)
  const credentialsValue = commonsDbRegistry.credentials as any;
  if (credentialsValue === undefined || credentialsValue === null) {
    errors.push(`commonsDbRegistry.credentials: required property is missing`);
  } else if (!Array.isArray(credentialsValue)) {
    errors.push(`commonsDbRegistry.credentials: expected array, got ${typeof credentialsValue}`);
  } else if (credentialsValue.length === 0) {
    errors.push(`commonsDbRegistry.credentials: array cannot be empty`);
  } else {
    credentialsValue.forEach((cred: any, index: number) => {
      if (typeof cred !== "object" || cred === null) {
        errors.push(`commonsDbRegistry.credentials[${index}]: expected object`);
      } else if (cred.proof === undefined || cred.proof === null) {
        errors.push(`commonsDbRegistry.credentials[${index}].proof: required property is missing`);
      } else if (typeof cred.proof !== "string") {
        errors.push(`commonsDbRegistry.credentials[${index}].proof: expected string, got ${typeof cred.proof}`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Fetches a JSON document from a URL with caching and local fallback
 * @param url - The URL to fetch
 * @param cache - The cache to use for storing fetched documents
 * @param type - The type of document being fetched ('schema' or 'context')
 * @returns The parsed JSON document
 */
async function fetchJsonDocument(url: string, cache: Map<string, object>, type: string): Promise<object> {
  // Check cache first
  if (cache.has(url)) {
    console.log(`[Schema Validation] Using cached ${type} from: ${url}`);
    return cache.get(url)!;
  }

  console.log(`[Schema Validation] Fetching ${type} from URL: ${url}`);

  try {
    const response = await axios.get(url, {
      timeout: 10000, // 10 second timeout
      headers: {
        Accept: "application/json",
        "User-Agent": "CommonsDB-Validator/1.0",
      },
    });

    if (typeof response.data !== "object") {
      throw new Error(`Invalid ${type} response: expected JSON object, got ${typeof response.data}`);
    }

    console.log(`[Schema Validation] Successfully fetched ${type} from: ${url}`);
    console.log(`[Schema Validation] ${type} title/id: ${response.data.title || response.data["$id"] || "N/A"}`);

    // Cache the result
    cache.set(url, response.data);

    return response.data;
  } catch (error: any) {
    console.warn(`[Schema Validation] Failed to fetch ${type} from ${url}: ${error.message}`);
    console.log(`[Schema Validation] Using local fallback ${type} (v${LOCAL_SCHEMA_VERSION})`);

    const fallback: object = type === "schema" ? LOCAL_SCHEMA : LOCAL_CONTEXT;

    // Cache the fallback for this URL
    cache.set(url, fallback);

    return fallback;
  }
}

/**
 * Validates the JSON-LD context structure
 * @param context - The fetched context object
 * @param publicMetadata - The public metadata to validate context mappings
 * @returns Validation result with any errors found
 */
function validateContextStructure(
  context: any,
  publicMetadata: IDeclarationPublicMetadata,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  console.log(`[Schema Validation] Validating JSON-LD context structure...`);

  // Check if context has required @context property
  if (!context["@context"]) {
    errors.push("Context document is missing @context property");
    return { valid: false, errors };
  }

  const contextDef = context["@context"];

  // Log the namespaces defined in the context
  const namespaces = Object.keys(contextDef).filter(
    (key) => !key.startsWith("@") && typeof contextDef[key] === "string",
  );
  console.log(`[Schema Validation] Context namespaces defined: ${namespaces.join(", ")}`);

  // Log the property mappings defined in the context
  const propertyMappings = Object.keys(contextDef).filter(
    (key) => !key.startsWith("@") && typeof contextDef[key] === "object",
  );
  console.log(`[Schema Validation] Context property mappings: ${propertyMappings.join(", ")}`);

  // Validate that key publicMetadata fields have corresponding context mappings
  const requiredContextFields = ["iscc", "name", "timestamp", "location", "rightsStatement"];
  const missingContextMappings: string[] = [];

  for (const field of requiredContextFields) {
    if (publicMetadata[field as keyof IDeclarationPublicMetadata] !== undefined) {
      if (!contextDef[field]) {
        missingContextMappings.push(field);
      }
    }
  }

  if (missingContextMappings.length > 0) {
    console.log(
      `[Schema Validation] Warning: Some fields present in publicMetadata lack context mappings: ${missingContextMappings.join(", ")}`,
    );
  }

  console.log(`[Schema Validation] Context structure validation completed`);

  return { valid: errors.length === 0, errors };
}

/**
 * Main validation function that fetches schema and context, then validates the declaration data
 * @param publicMetadata - The public metadata containing schema and context URLs
 * @param commonsDbRegistry - The optional commons DB registry data to validate
 * @returns Validation result with detailed error information
 */
async function validateDeclarationAgainstSchemaAndContext(
  publicMetadata: IDeclarationPublicMetadata,
  commonsDbRegistry?: IDeclarationCommonsDbRegistry,
): Promise<ValidationResult> {
  console.log(`[Schema Validation] ========================================`);
  console.log(`[Schema Validation] Starting declaration validation`);
  console.log(`[Schema Validation] ========================================`);

  const allErrors: string[] = [];
  let schemaVersion: string | undefined;
  let contextVersion: string | undefined;

  // CRITICAL: Reject if $schema or @context is not provided
  if (!publicMetadata["$schema"]) {
    console.error(`[Schema Validation] REJECTED: $schema URL is required but not provided`);
    allErrors.push("publicMetadata.$schema: required property is missing - $schema URL must be provided");
  }
  if (!publicMetadata["@context"]) {
    console.error(`[Schema Validation] REJECTED: @context URL is required but not provided`);
    allErrors.push("publicMetadata.@context: required property is missing - @context URL must be provided");
  }

  // If $schema or @context is missing, return early with errors
  if (!publicMetadata["$schema"] || !publicMetadata["@context"]) {
    return {
      valid: false,
      errors: allErrors,
      schemaVersion: undefined,
      contextVersion: undefined,
    };
  }

  // CRITICAL: Validate $schema URL pattern and version
  const schemaUrlValidation = validateSchemaUrl(publicMetadata["$schema"], "schema");
  if (!schemaUrlValidation.valid) {
    console.error(`[Schema Validation] REJECTED: ${schemaUrlValidation.error}`);
    allErrors.push(`publicMetadata.$schema: ${schemaUrlValidation.error}`);
  } else {
    schemaVersion = schemaUrlValidation.version;
    console.log(`[Schema Validation] $schema URL valid, version: ${schemaVersion}`);
  }

  // CRITICAL: Validate @context URL pattern and version
  const contextUrlValidation = validateSchemaUrl(publicMetadata["@context"], "context");
  if (!contextUrlValidation.valid) {
    console.error(`[Schema Validation] REJECTED: ${contextUrlValidation.error}`);
    allErrors.push(`publicMetadata.@context: ${contextUrlValidation.error}`);
  } else {
    contextVersion = contextUrlValidation.version;
    console.log(`[Schema Validation] @context URL valid, version: ${contextVersion}`);
  }

  // If schema or context URL is invalid, return early with errors
  if (!schemaUrlValidation.valid || !contextUrlValidation.valid) {
    return {
      valid: false,
      errors: allErrors,
      schemaVersion,
      contextVersion,
    };
  }

  // Validate publicMetadata structure first (built-in validation)
  const publicMetadataStructureValidation = validatePublicMetadataStructure(publicMetadata);
  if (!publicMetadataStructureValidation.valid) {
    allErrors.push(...publicMetadataStructureValidation.errors);
  }

  // Validate commonsDbRegistry structure if present (built-in validation)
  if (commonsDbRegistry) {
    const commonsDbValidation = validateCommonsDbRegistryStructure(commonsDbRegistry);
    if (!commonsDbValidation.valid) {
      allErrors.push(...commonsDbValidation.errors);
    }
  }

  // Fetch and validate against external schema
  console.log(`[Schema Validation] $schema URL: ${publicMetadata["$schema"]}`);

  try {
    // Fetch the schema
    const schema = (await fetchJsonDocument(publicMetadata["$schema"], schemaCache, "schema")) as any;
    schemaVersion = schema["$id"] || schema.title || publicMetadata["$schema"];

    // Extract sub-schemas from $defs for publicMetadata and commonsDbRegistry
    const publicMetadataSchema = schema.$defs?.PublicMetadata;
    const commonsDbRegistrySchema = schema.$defs?.CommonsDbRegistry;

    // Validate publicMetadata against its sub-schema (if available)
    if (publicMetadataSchema) {
      console.log(`[Schema Validation] Validating publicMetadata against PublicMetadata sub-schema`);
      const schemaValidation = validateAgainstJsonSchema(publicMetadata, publicMetadataSchema, "publicMetadata");
      if (!schemaValidation.valid) {
        allErrors.push(...schemaValidation.errors);
      }
    } else {
      console.log(
        `[Schema Validation] No PublicMetadata sub-schema found, skipping schema validation for publicMetadata`,
      );
    }

    // Validate commonsDbRegistry against its sub-schema if present
    if (commonsDbRegistry && commonsDbRegistrySchema) {
      console.log(`[Schema Validation] Validating commonsDbRegistry against CommonsDbRegistry sub-schema`);
      const commonsDbSchemaValidation = validateAgainstJsonSchema(
        commonsDbRegistry,
        commonsDbRegistrySchema,
        "commonsDbRegistry",
      );
      if (!commonsDbSchemaValidation.valid) {
        allErrors.push(...commonsDbSchemaValidation.errors);
      }
    }
  } catch (error: any) {
    console.error(`[Schema Validation] Schema fetch/validation failed:`, error.message);
    allErrors.push(`Schema validation failed: ${error.message}`);
  }

  // Fetch and validate context
  console.log(`[Schema Validation] @context URL: ${publicMetadata["@context"]}`);

  try {
    // Fetch the context
    const context = await fetchJsonDocument(publicMetadata["@context"], contextCache, "context");
    contextVersion = (context as any)["$id"] || publicMetadata["@context"];

    // Validate context structure
    const contextValidation = validateContextStructure(context, publicMetadata);
    if (!contextValidation.valid) {
      allErrors.push(...contextValidation.errors);
    }
  } catch (error: any) {
    console.error(`[Schema Validation] Context fetch/validation failed:`, error.message);
    allErrors.push(`Context validation failed: ${error.message}`);
  }

  // Summary log
  console.log(`[Schema Validation] ========================================`);
  if (allErrors.length === 0) {
    console.log(`[Schema Validation] Validation PASSED - All checks successful`);
  } else {
    console.log(`[Schema Validation] Validation FAILED with ${allErrors.length} error(s):`);
    allErrors.forEach((err, idx) => {
      console.error(`[Schema Validation]   ${idx + 1}. ${err}`);
    });
  }
  console.log(`[Schema Validation] ========================================`);

  return {
    valid: allErrors.length === 0,
    errors: allErrors.length > 0 ? allErrors : undefined,
    schemaVersion,
    contextVersion,
  };
}

/**
 * Extracts the JWK from a JWT header and converts it to a PEM public key
 * @param token - The JWT token string
 * @returns The public key in PEM format, or null if JWK is not present
 */
function extractPublicKeyFromJwtHeader(token: string): string | null {
  try {
    // Decode the JWT header without verification
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header) {
      console.log("[JWK Verification] Failed to decode JWT header");
      return null;
    }

    const header = decoded.header as jwt.JwtHeader & { jwk?: crypto.JsonWebKey };
    if (!header.jwk) {
      console.log("[JWK Verification] No JWK found in JWT header");
      return null;
    }

    console.log("[JWK Verification] Found JWK in header:", JSON.stringify(header.jwk));

    // Convert JWK to KeyObject and then to PEM
    const keyObject = crypto.createPublicKey({ key: header.jwk, format: "jwk" });
    const pemKey = keyObject.export({ type: "spki", format: "pem" }) as string;

    console.log("[JWK Verification] Successfully converted JWK to PEM");
    return pemKey;
  } catch (error: any) {
    console.error("[JWK Verification] Error extracting public key from JWT header:", error.message);
    return null;
  }
}

/**
 * Verifies a JWT signature using the JWK embedded in its header
 * @param token - The JWT token string
 * @returns Object with verification result and decoded payload
 */
function verifyJwtWithEmbeddedJwk(token: string): { valid: boolean; payload?: any; error?: string } {
  const publicKeyPem = extractPublicKeyFromJwtHeader(token);

  if (!publicKeyPem) {
    return { valid: false, error: "No JWK found in JWT header or failed to extract public key" };
  }

  try {
    const payload = jwt.verify(token, publicKeyPem, { algorithms: ["ES256"] });
    console.log("[JWK Verification] JWT signature verified successfully using embedded JWK");
    return { valid: true, payload };
  } catch (error: any) {
    console.error("[JWK Verification] JWT verification failed:", error.message);
    return { valid: false, error: error.message };
  }
}

/**
 * Verifies that the signed JWT payload strictly matches the provided publicMetadata
 * This ensures that the signature covers the exact content being declared
 * @param signedPayload - The payload extracted from the verified JWT
 * @param publicMetadata - The publicMetadata from the declaration request
 * @returns Object with verification result and list of mismatches
 */
function verifySignatureContentMatchesPublicMetadata(
  signedPayload: any,
  publicMetadata: IDeclarationPublicMetadata,
): { valid: boolean; mismatches: string[] } {
  console.log("[Content Verification] Starting strict content verification...");

  const mismatches: string[] = [];

  // Remove JWT-specific fields (iat, exp, etc.) from the signed payload for comparison
  const jwtSpecificFields = ["iat", "exp", "nbf", "iss", "sub", "aud", "jti"];
  const signedContentFields = Object.keys(signedPayload).filter((key) => !jwtSpecificFields.includes(key));

  // Required fields that MUST be in the signature and MUST match
  const requiredSignedFields = ["$schema", "@context", "iscc", "name", "timestamp", "declarerId"];

  // Check that all required fields are present in the signed payload
  for (const field of requiredSignedFields) {
    if (signedPayload[field] === undefined) {
      mismatches.push(`Missing required field in signature: ${field}`);
    }
  }

  // Verify that each field in the signed payload matches publicMetadata
  for (const field of signedContentFields) {
    const signedValue = signedPayload[field];
    const publicValue = (publicMetadata as any)[field];

    // Deep comparison for objects/arrays
    const signedJson = JSON.stringify(signedValue);
    const publicJson = JSON.stringify(publicValue);

    if (signedJson !== publicJson) {
      mismatches.push(`Field '${field}' mismatch - signed value differs from publicMetadata`);
      console.log(`[Content Verification] Mismatch in field '${field}':`);
      console.log(`[Content Verification]   Signed: ${signedJson?.substring(0, 100)}...`);
      console.log(`[Content Verification]   Public: ${publicJson?.substring(0, 100)}...`);
    }
  }

  // Verify critical fields explicitly for clear error messages
  if (signedPayload["$schema"] !== publicMetadata["$schema"]) {
    if (!mismatches.some((m) => m.includes("'$schema'"))) {
      mismatches.push(
        `Critical field '$schema' mismatch: signature contains '${signedPayload["$schema"]}', publicMetadata has '${publicMetadata["$schema"]}'`,
      );
    }
  }

  if (signedPayload["@context"] !== publicMetadata["@context"]) {
    if (!mismatches.some((m) => m.includes("'@context'"))) {
      mismatches.push(
        `Critical field '@context' mismatch: signature contains '${signedPayload["@context"]}', publicMetadata has '${publicMetadata["@context"]}'`,
      );
    }
  }

  if (signedPayload.iscc !== publicMetadata.iscc) {
    if (!mismatches.some((m) => m.includes("'iscc'"))) {
      mismatches.push(
        `Critical field 'iscc' mismatch: signature contains '${signedPayload.iscc}', publicMetadata has '${publicMetadata.iscc}'`,
      );
    }
  }

  if (signedPayload.timestamp !== publicMetadata.timestamp) {
    if (!mismatches.some((m) => m.includes("'timestamp'"))) {
      mismatches.push(
        `Critical field 'timestamp' mismatch: signature contains '${signedPayload.timestamp}', publicMetadata has '${publicMetadata.timestamp}'`,
      );
    }
  }

  if (signedPayload.declarerId !== publicMetadata.declarerId) {
    if (!mismatches.some((m) => m.includes("'declarerId'"))) {
      mismatches.push(
        `Critical field 'declarerId' mismatch: signature contains '${signedPayload.declarerId}', publicMetadata has '${publicMetadata.declarerId}'`,
      );
    }
  }

  const valid = mismatches.length === 0;

  if (valid) {
    console.log("[Content Verification] All signed fields match publicMetadata - PASSED");
  } else {
    console.error(`[Content Verification] Content verification FAILED with ${mismatches.length} mismatch(es)`);
    mismatches.forEach((m) => console.error(`[Content Verification]   - ${m}`));
  }

  return { valid, mismatches };
}

/**
 * Checks if a timestamp is within 60 seconds of a reference time
 * @param {number} timestamp - The timestamp to validate (expected in milliseconds)
 * @param {number} [referenceTime] - Optional reference time to compare against (defaults to Date.now())
 * @returns {{ valid: boolean; error?: string }} - validation result with optional error message
 */
function isTimestampWithin60Seconds(timestamp: number, referenceTime?: number): { valid: boolean; error?: string } {
  // Check if timestamp is a number
  if (typeof timestamp !== "number" || isNaN(timestamp)) {
    return { valid: false, error: "Timestamp is not a valid number" };
  }

  // Use provided reference time or current time in milliseconds
  const now = referenceTime ?? Date.now();

  // Calculate the time difference (absolute value for both past and future)
  const timeDifference = now - timestamp;
  const absDifference = Math.abs(timeDifference);

  // Check if timestamp is within 60 seconds window (60,000 milliseconds)
  const sixtySecondsInMs = 60 * 1000;

  if (absDifference > sixtySecondsInMs) {
    const direction = timeDifference > 0 ? "old" : "in the future";
    const secondsDiff = Math.floor(absDifference / 1000);
    return {
      valid: false,
      error: `Timestamp is ${secondsDiff} seconds ${direction} (max allowed: 60 seconds from server time)`,
    };
  }

  return { valid: true };
}

/**
 * Verifies TSA signature by checking only the content match between TSQ and TSR
 * Does NOT check timestamp expiration or age
 * @param tsaSignature - Object containing tsr and tsq in base64
 * @param originalData - The original data that was timestamped (usually the JWT signature)
 * @returns Verification result with errors if any
 */
function verifyTsaSignatureContentOnly(
  tsaSignature: { tsr: string; tsq: string },
  originalData: string,
): { valid: boolean; errors: string[] } {
  console.log("[TSA Content Verification] Starting TSA content-only verification");

  const errors: string[] = [];

  // Step 1: Parse TSQ
  const tsqData = parseTSQ(tsaSignature.tsq);
  if (!tsqData) {
    errors.push("Failed to parse TimeStampQuery (TSQ) - invalid format");
    return { valid: false, errors };
  }
  console.log("[TSA Content Verification] TSQ parsed successfully");
  console.log(`[TSA Content Verification]   Algorithm: ${tsqData.hashAlgorithm}`);

  // Step 2: Parse TSR
  const tsrData = parseTSR(tsaSignature.tsr);
  if (!tsrData) {
    errors.push("Failed to parse TimeStampResponse (TSR) - invalid format");
    return { valid: false, errors };
  }
  console.log("[TSA Content Verification] TSR parsed successfully");
  console.log(`[TSA Content Verification]   Timestamp: ${tsrData.timestamp?.toISOString()}`);

  // Step 3: Verify TSQ hash matches TSR hash (TSA signed what was requested)
  const tsqHashHex = tsqData.hash.toString("hex");
  const tsrHashHex = tsrData.hash.toString("hex");

  if (tsqHashHex !== tsrHashHex) {
    console.error("[TSA Content Verification] MISMATCH: TSQ hash does not match TSR hash");
    errors.push("TSQ hash does not match TSR hash - timestamp response is for different data");
    return { valid: false, errors };
  }
  console.log("[TSA Content Verification] TSQ hash matches TSR hash - PASSED");

  // Step 4: Verify the hash matches the original data (the signature)
  const computedHash = crypto.createHash(tsqData.hashAlgorithm).update(originalData).digest();
  const computedHashHex = computedHash.toString("hex");

  if (computedHashHex !== tsqHashHex) {
    console.error("[TSA Content Verification] MISMATCH: Computed hash does not match TSQ hash");
    errors.push("Hash mismatch - the timestamp is not for the provided signature data");
    return { valid: false, errors };
  }
  console.log("[TSA Content Verification] Hash matches original data - PASSED");

  console.log("[TSA Content Verification] TSA content verification PASSED");
  return { valid: true, errors: [] };
}

// Pinned declarer public keys — fallback JWT verification for declarers whose
// tokens carry no embedded JWK. Loaded from the SECRET_TRUSTED_DECLARER_KEYS
// secret: a JSON object mapping declarer DID → PEM-encoded EC public key
// (JSON string escaping covers the PEM newlines). Set the secret to "_" to
// disable pinning entirely. Loaded lazily so importing this module does not
// require the binding.
let companyPublicKeyMappingCache: Record<string, string> | null = null;
function getCompanyPublicKeyMapping(): Record<string, string> {
  if (companyPublicKeyMappingCache !== null) return companyPublicKeyMappingCache;
  const raw = Config.SECRET_TRUSTED_DECLARER_KEYS;
  if (!raw || raw === "_") {
    companyPublicKeyMappingCache = {};
    return companyPublicKeyMappingCache;
  }
  try {
    companyPublicKeyMappingCache = JSON.parse(raw);
  } catch (err) {
    console.error("[Ingest] SECRET_TRUSTED_DECLARER_KEYS is not valid JSON — key pinning disabled:", err);
    companyPublicKeyMappingCache = {};
  }
  return companyPublicKeyMappingCache!;
}

/**
 * Validates the full declaration structure against the schema
 * This validates the entire request payload including signatures
 */
function validateFullDeclarationStructure(data: IDeclarationPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  console.log("[Full Declaration Validation] Starting full declaration structure validation");

  // Validate top-level required fields
  if (!data.signature || typeof data.signature !== "string") {
    errors.push("signature: required string field is missing or invalid");
  } else if (!data.signature.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
    errors.push("signature: invalid JWT format");
  }

  // Validate tsaSignature
  if (!data.tsaSignature) {
    errors.push("tsaSignature: required field is missing");
  } else if (typeof data.tsaSignature !== "object") {
    errors.push("tsaSignature: expected object");
  } else {
    if (!data.tsaSignature.tsr || typeof data.tsaSignature.tsr !== "string") {
      errors.push("tsaSignature.tsr: required string field is missing or invalid");
    }
    if (!data.tsaSignature.tsq || typeof data.tsaSignature.tsq !== "string") {
      errors.push("tsaSignature.tsq: required string field is missing or invalid");
    }
  }

  // Validate declarationMetadata
  if (!data.declarationMetadata) {
    errors.push("declarationMetadata: required field is missing");
  } else if (typeof data.declarationMetadata !== "object") {
    errors.push("declarationMetadata: expected object");
  } else {
    // Validate publicMetadata
    if (!data.declarationMetadata.publicMetadata) {
      errors.push("declarationMetadata.publicMetadata: required field is missing");
    } else {
      const pm = data.declarationMetadata.publicMetadata;

      // Required fields in publicMetadata
      if (!pm.iscc || typeof pm.iscc !== "string") {
        errors.push("declarationMetadata.publicMetadata.iscc: required string field is missing or invalid");
      }
      if (!pm.name || typeof pm.name !== "string") {
        errors.push("declarationMetadata.publicMetadata.name: required string field is missing or invalid");
      }
      if (pm.timestamp === undefined || typeof pm.timestamp !== "number") {
        errors.push("declarationMetadata.publicMetadata.timestamp: required number field is missing or invalid");
      }
      if (!pm.declarerId || typeof pm.declarerId !== "string") {
        errors.push("declarationMetadata.publicMetadata.declarerId: required string field is missing or invalid");
      }

      // Validate credentials array in publicMetadata if present
      // Note: credentials might be a string in IDeclarationPublicMetadata but the schema expects array
    }

    // Validate optOutMetadata - when present, optOutRegistrySignature and optOutRegistryTsaSignature are required
    if (data.declarationMetadata.optOutMetadata) {
      const odm = data.declarationMetadata.optOutMetadata;
      if (!odm.iscc || typeof odm.iscc !== "string") {
        errors.push("declarationMetadata.optOutMetadata.iscc: required string field is missing or invalid");
      }
      if (!odm.credentials || !Array.isArray(odm.credentials)) {
        errors.push("declarationMetadata.optOutMetadata.credentials: required array field is missing or invalid");
      }
      if (!odm.usagePermission || typeof odm.usagePermission !== "string") {
        errors.push("declarationMetadata.optOutMetadata.usagePermission: required string field is missing or invalid");
      }
      if (!odm.cid || typeof odm.cid !== "string") {
        errors.push("declarationMetadata.optOutMetadata.cid: required string field is missing or invalid");
      }
      if (!data.optOutRegistrySignature || typeof data.optOutRegistrySignature !== "string") {
        errors.push("optOutRegistrySignature: required when optOutMetadata is provided");
      } else if (!data.optOutRegistrySignature.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
        errors.push("optOutRegistrySignature: invalid JWT format");
      }
      if (!data.optOutRegistryTsaSignature) {
        errors.push("optOutRegistryTsaSignature: required when optOutMetadata is provided");
      } else if (typeof data.optOutRegistryTsaSignature !== "object") {
        errors.push("optOutRegistryTsaSignature: expected object");
      } else {
        if (!data.optOutRegistryTsaSignature.tsr || typeof data.optOutRegistryTsaSignature.tsr !== "string") {
          errors.push("optOutRegistryTsaSignature.tsr: required string field is missing or invalid");
        }
        if (!data.optOutRegistryTsaSignature.tsq || typeof data.optOutRegistryTsaSignature.tsq !== "string") {
          errors.push("optOutRegistryTsaSignature.tsq: required string field is missing or invalid");
        }
      }
    }

    // Validate commonsDbRegistry if present
    if (data.declarationMetadata.commonsDbRegistry) {
      const cdr = data.declarationMetadata.commonsDbRegistry;

      // Required fields in commonsDbRegistry
      if (!cdr.iscc || typeof cdr.iscc !== "string") {
        errors.push("declarationMetadata.commonsDbRegistry.iscc: required string field is missing or invalid");
      }
      if (!cdr.location || typeof cdr.location !== "string") {
        errors.push("declarationMetadata.commonsDbRegistry.location: required string field is missing or invalid");
      }
      if (!cdr.rightsStatement || typeof cdr.rightsStatement !== "string") {
        errors.push(
          "declarationMetadata.commonsDbRegistry.rightsStatement: required string field is missing or invalid",
        );
      } else if (!isValidRightsStatement(cdr.rightsStatement)) {
        errors.push(
          `declarationMetadata.commonsDbRegistry.rightsStatement: invalid value "${cdr.rightsStatement}" - must be a valid Creative Commons or Public Domain license URL`,
        );
      }
      if (cdr.timestamp === undefined || typeof cdr.timestamp !== "number") {
        errors.push("declarationMetadata.commonsDbRegistry.timestamp: required number field is missing or invalid");
      }

      // Validate credentials array
      const credentialsValue = cdr.credentials as any;
      if (!credentialsValue || !Array.isArray(credentialsValue)) {
        errors.push("declarationMetadata.commonsDbRegistry.credentials: required array field is missing or invalid");
      } else if (credentialsValue.length === 0) {
        errors.push("declarationMetadata.commonsDbRegistry.credentials: array cannot be empty");
      } else {
        credentialsValue.forEach((cred: any, index: number) => {
          if (!cred || typeof cred !== "object") {
            errors.push(`declarationMetadata.commonsDbRegistry.credentials[${index}]: expected object`);
          } else if (!cred.proof || typeof cred.proof !== "string") {
            errors.push(
              `declarationMetadata.commonsDbRegistry.credentials[${index}].proof: required string field is missing`,
            );
          }
        });
      }

      // If commonsDbRegistry is present, commonsDbRegistrySignature and commonsDbRegistryTsaSignature are required
      if (!data.commonsDbRegistrySignature || typeof data.commonsDbRegistrySignature !== "string") {
        errors.push("commonsDbRegistrySignature: required when commonsDbRegistry is provided");
      } else if (!data.commonsDbRegistrySignature.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)) {
        errors.push("commonsDbRegistrySignature: invalid JWT format");
      }

      if (!data.commonsDbRegistryTsaSignature) {
        errors.push("commonsDbRegistryTsaSignature: required when commonsDbRegistry is provided");
      } else if (typeof data.commonsDbRegistryTsaSignature !== "object") {
        errors.push("commonsDbRegistryTsaSignature: expected object");
      } else {
        if (!data.commonsDbRegistryTsaSignature.tsr || typeof data.commonsDbRegistryTsaSignature.tsr !== "string") {
          errors.push("commonsDbRegistryTsaSignature.tsr: required string field is missing or invalid");
        }
        if (!data.commonsDbRegistryTsaSignature.tsq || typeof data.commonsDbRegistryTsaSignature.tsq !== "string") {
          errors.push("commonsDbRegistryTsaSignature.tsq: required string field is missing or invalid");
        }
      }
    }
  }

  console.log(
    `[Full Declaration Validation] Validation ${errors.length === 0 ? "PASSED" : `FAILED with ${errors.length} error(s)`}`,
  );
  if (errors.length > 0) {
    errors.forEach((err) => console.error(`[Full Declaration Validation] Error: ${err}`));
  }

  return { valid: errors.length === 0, errors };
}

export const ingest = ApiHandler(async (_evt) => {
  console.log("ingest ApiHandler called");

  if (_evt.requestContext.http.method !== "POST") {
    return {
      statusCode: 405,
      body: "Method not allowed",
    };
  }

  // check for key in headers 						SECRET_ZUPLO_ACCESS_KEY,
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }
  // get json data from event body
  const bod = await _evt.body;
  let data: IDeclarationPayload | undefined = undefined;
  try {
    data = bod ? JSON.parse(bod) : undefined;
  } catch (e) {
    console.log("error parsing body: ", e);
    return {
      statusCode: 400,
      body: "Invalid request body",
    };
  }

  if (!data) {
    return {
      statusCode: 400,
      body: "Invalid request body",
    };
  }
  data = initializeMetaInternal(data, _evt.headers);

  console.log("ingest event data: " + JSON.stringify(data));

  //example iscc: "ISCC:KEC36L77X5666SXZQLS6OX2NQKCS3FVNIEY6PLHMH4WY34X4MUXWBYI"
  const companyIdValue = _evt.headers["x-company-id"];
  console.log("companyIdValue: ", companyIdValue);

  const companyPublicKey = (companyIdValue && getCompanyPublicKeyMapping()[companyIdValue]) || "";
  console.log("companyPublicKey: ", companyPublicKey);

  const declarerId = _evt.headers["x-declarer-id"];
  console.log("declarerId: ", declarerId);

  // Declarer ids allowed to skip strict validation (declarerId-consistency and
  // signature/TSA verification) — legacy test declarers. Comma-separated in the
  // SECRET_VALIDATION_BYPASS_DECLARERS secret; "_" disables all bypassing.
  const validationBypassDeclarers = (Config.SECRET_VALIDATION_BYPASS_DECLARERS || "_")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "_");
  const skipStrictValidation = !!declarerId && validationBypassDeclarers.includes(declarerId);
  if (skipStrictValidation) {
    console.log("[Ingest] WARNING: strict validation bypassed for declarer:", declarerId);
  }

  // ========================================
  // DeclarerId Consistency Validation
  // ========================================
  // Ensure publicMetadata.declarerId matches the header x-declarer-id (from verified credentials)
  const publicMetadataDeclarerId = data.declarationMetadata?.publicMetadata?.declarerId;

  if (!skipStrictValidation) {
    if (!publicMetadataDeclarerId) {
      console.error("[Ingest] DeclarerId validation FAILED: publicMetadata.declarerId is missing");
      return {
        statusCode: 422,
        body: JSON.stringify({
          error: "DeclarerId validation failed",
          message: "publicMetadata.declarerId is required",
        }),
      };
    }

    if (publicMetadataDeclarerId !== declarerId) {
      console.error(
        `[Ingest] DeclarerId MISMATCH: header='${declarerId}', publicMetadata='${publicMetadataDeclarerId}'`,
      );
      return {
        statusCode: 422,
        body: JSON.stringify({
          error: "DeclarerId mismatch",
          message:
            "publicMetadata.declarerId must match the declarerId from verified credentials (x-declarer-id header)",
          headerDeclarerId: declarerId,
          publicMetadataDeclarerId: publicMetadataDeclarerId,
        }),
      };
    }
    console.log("[Ingest] DeclarerId consistency validation PASSED");
  }

  // Capture reference time for timestamp validation immediately after basic checks
  // This prevents timestamp validation failures due to slow schema/structure validation
  const ingestStartTime = Date.now();
  console.log(`[Ingest] Captured reference time for timestamp validation: ${ingestStartTime}`);

  // ========================================
  // Full Declaration Structure Validation
  // ========================================
  // Validate the entire declaration structure including signatures
  console.log("[Ingest] Starting full declaration structure validation...");

  const fullValidation = validateFullDeclarationStructure(data);
  if (!fullValidation.valid) {
    console.error("[Ingest] Full declaration structure validation FAILED");
    console.error(`[Ingest] Validation errors: ${JSON.stringify(fullValidation.errors)}`);

    return {
      statusCode: 422,
      body: JSON.stringify({
        error: "Declaration structure validation failed",
        message: "The declaration does not conform to the required structure",
        validationErrors: fullValidation.errors,
      }),
    };
  }
  console.log("[Ingest] Full declaration structure validation PASSED");

  // ========================================
  // Supersedes Validation (Early Check)
  // ========================================
  // Check supersedes field before any heavy processing
  // This prevents unnecessary work if the supersedes reference is invalid
  // Also protects against cross-event attacks where different declarers try to supersede simultaneously
  const supersedes = (data.declarationMetadata?.publicMetadata as any)?.supersedes;
  if (supersedes && typeof supersedes === "string" && supersedes.trim() !== "") {
    const newDeclarerId = data.declarationMetadata?.publicMetadata?.declarerId;
    console.log(`[Ingest] Validating supersedes field: ${supersedes} by declarerId: ${newDeclarerId}`);

    if (!newDeclarerId) {
      console.error("[Ingest] Supersedes validation FAILED: declarerId is required");
      return {
        statusCode: 422,
        body: JSON.stringify({
          error: "Supersedes validation failed",
          message: "declarerId is required when using supersedes field",
          supersedes: supersedes,
        }),
      };
    }

    try {
      const supersedesValidation = await validateSupersedes(supersedes, newDeclarerId);

      if (!supersedesValidation.valid) {
        console.error("[Ingest] Supersedes validation FAILED:", supersedesValidation.error);

        return {
          statusCode: 422,
          body: JSON.stringify({
            error: "Supersedes validation failed",
            message: supersedesValidation.error,
            supersedes: supersedes,
            ...(supersedesValidation.existingSupersededBy && {
              existingSupersededBy: supersedesValidation.existingSupersededBy,
            }),
            ...(supersedesValidation.originalDeclarerId && {
              originalDeclarerId: supersedesValidation.originalDeclarerId,
            }),
          }),
        };
      }
      console.log("[Ingest] Supersedes validation PASSED");
    } catch (supersedesError: any) {
      console.error("[Ingest] Supersedes validation encountered an error:", supersedesError.message);

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Supersedes validation error",
          message: "Failed to validate supersedes reference",
          details: supersedesError.message,
          supersedes: supersedes,
        }),
      };
    }
  }

  const iscc = data.declarationMetadata!.publicMetadata!.iscc!;
  const isMatch = iscc.toUpperCase().match(/ISCC:[A-Z0-9]{55}/);
  if (!isMatch) {
    return {
      statusCode: 400,
      body: `Invalid ISCC code: ${iscc}`,
    };
  }

  // ========================================
  // Schema and Context Validation (Optional)
  // ========================================
  // Validate publicMetadata and commonsDbRegistry against external schema and context
  // if URLs are provided in publicMetadata.$schema and publicMetadata.@context
  console.log("[Ingest] Checking $schema and @context URLs...");
  console.log(
    `[Ingest] publicMetadata.$schema: ${data.declarationMetadata!.publicMetadata!["$schema"] || "NOT PROVIDED"}`,
  );
  console.log(
    `[Ingest] publicMetadata.@context: ${data.declarationMetadata!.publicMetadata!["@context"] || "NOT PROVIDED"}`,
  );

  try {
    const validationResult = await validateDeclarationAgainstSchemaAndContext(
      data.declarationMetadata!.publicMetadata!,
      data.declarationMetadata!.commonsDbRegistry,
    );

    if (!validationResult.valid) {
      console.error("[Ingest] Declaration validation FAILED");
      console.error(`[Ingest] Schema version: ${validationResult.schemaVersion || "N/A"}`);
      console.error(`[Ingest] Context version: ${validationResult.contextVersion || "N/A"}`);
      console.error(`[Ingest] Validation errors: ${JSON.stringify(validationResult.errors)}`);

      return {
        statusCode: 422,
        body: JSON.stringify({
          error: "Declaration validation failed",
          message:
            "The provided publicMetadata and/or RegistryMetadata do not conform to the $schema and @context specifications",
          schemaUrl: data.declarationMetadata.publicMetadata["$schema"] || "Not provided",
          contextUrl: data.declarationMetadata.publicMetadata["@context"] || "Not provided",
          schemaVersion: validationResult.schemaVersion,
          contextVersion: validationResult.contextVersion,
          validationErrors: validationResult.errors,
          iscc: iscc,
        }),
      };
    }

    console.log("[Ingest] Declaration validation PASSED");
    console.log(`[Ingest] Validated against schema: ${validationResult.schemaVersion || "N/A"}`);
    console.log(`[Ingest] Validated against context: ${validationResult.contextVersion || "N/A"}`);
  } catch (validationError: any) {
    console.error("[Ingest] Declaration validation encountered an unexpected error:", validationError.message);
    console.error("[Ingest] Validation error stack:", validationError.stack);

    return {
      statusCode: 502,
      body: JSON.stringify({
        error: "Schema/Context validation error",
        message: "Failed to fetch or process the $schema and/or @context for validation",
        details: validationError.message,
        schemaUrl: data.declarationMetadata.publicMetadata["$schema"] || "Not provided",
        contextUrl: data.declarationMetadata.publicMetadata["@context"] || "Not provided",
        iscc: iscc,
      }),
    };
  }

  // Validate timestamp is within 60 seconds of server time
  if (data.declarationMetadata.publicMetadata.timestamp) {
    const timestampCheck = isTimestampWithin60Seconds(
      data.declarationMetadata.publicMetadata.timestamp,
      ingestStartTime,
    );
    if (!timestampCheck.valid) {
      console.log("declarationMetadata.publicMetadata.timestamp check failed:", timestampCheck.error);
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Timestamp validation failed",
          message: timestampCheck.error,
          providedTimestamp: data.declarationMetadata.publicMetadata.timestamp,
          serverTime: ingestStartTime,
          iscc: iscc,
        }),
      };
    }
    console.log("[Ingest] publicMetadata.timestamp validation PASSED (within 60 seconds)");
  }

  //signature verification
  if (!skipStrictValidation) {
    // First, try to verify using JWK embedded in JWT header
    console.log("[Ingest] Attempting signature verification using embedded JWK...");
    const jwkVerificationResult = verifyJwtWithEmbeddedJwk(data.signature);

    let signedPayload: any = null;

    if (jwkVerificationResult.valid) {
      console.log("[Ingest] Signature verified successfully using embedded JWK");
      console.log("[Ingest] Verified payload:", JSON.stringify(jwkVerificationResult.payload));
      signedPayload = jwkVerificationResult.payload;
    } else {
      // Fallback to company public key mapping if JWK verification fails
      console.log("[Ingest] JWK verification failed, falling back to company public key mapping");
      console.log("[Ingest] JWK error:", jwkVerificationResult.error);

      try {
        if (!companyPublicKey) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: "Signature verification failed",
              message: "No JWK in JWT header and no registered public key for company",
              jwkError: jwkVerificationResult.error,
            }),
          };
        }

        console.log("[Ingest] Using registered company public key for verification");
        const verificationResult = jwt.verify(data.signature, companyPublicKey, { algorithms: ["ES256"] });
        console.log("[Ingest] Signature verification result (fallback):", JSON.stringify(verificationResult));
        signedPayload = verificationResult;
      } catch (e) {
        console.log("[Ingest] Signature decode failed:", JSON.stringify(e));
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "Signature verification failed",
            message: "Invalid signature - both JWK and fallback verification failed",
            jwkError: jwkVerificationResult.error,
          }),
        };
      }
    }

    // ========================================
    // Strict Content Verification
    // ========================================
    // Verify that the signed payload matches the publicMetadata exactly
    // This ensures schema, context, and all critical fields are included in the signature
    if (signedPayload) {
      console.log("[Ingest] Starting strict content verification...");
      const contentVerification = verifySignatureContentMatchesPublicMetadata(
        signedPayload,
        data.declarationMetadata!.publicMetadata!,
      );

      if (!contentVerification.valid) {
        console.error("[Ingest] Strict content verification FAILED");
        console.error(`[Ingest] Content mismatches: ${JSON.stringify(contentVerification.mismatches)}`);

        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "Signature content verification failed",
            message:
              "The signed payload does not match the publicMetadata - signature must cover the complete publicMetadata including $schema and @context",
            mismatches: contentVerification.mismatches,
            iscc: iscc,
          }),
        };
      }
      console.log("[Ingest] Strict content verification PASSED");
    }

    if (!data.tsaSignature) {
      console.log("tsaSignature check failed:");
      return {
        statusCode: 400,
        body: "Invalid request body data invalid tsaSignature",
      };
    }

    // ========================================
    // TSA Signature Verification (Main Signature) - Content Only
    // ========================================
    // Verify the TSA timestamp signature by checking TSQ/TSR content match only
    // Does NOT check timestamp expiration or age
    console.log("[Ingest] Verifying main TSA signature (content only)...");
    const mainTsaResult = verifyTsaSignatureContentOnly(data.tsaSignature, data.signature);

    if (!mainTsaResult.valid) {
      console.error("[Ingest] Main TSA signature content verification FAILED");
      console.error(`[Ingest] TSA errors: ${JSON.stringify(mainTsaResult.errors)}`);

      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "TSA signature verification failed",
          message: "The TSA signature content verification failed - TSQ/TSR hash mismatch",
          tsaErrors: mainTsaResult.errors,
          iscc: iscc,
        }),
      };
    }

    console.log("[Ingest] Main TSA signature content verification PASSED");
  }

  if (data.declarationMetadata.commonsDbRegistry) {
    if (!skipStrictValidation) {
      if (!data.commonsDbRegistrySignature) {
        return {
          statusCode: 400,
          body: "Invalid request body data invalid commonsDbRegistrySignature",
        };
      }
      // First, try to verify using JWK embedded in JWT header
      console.log("[Ingest] Attempting commonsDbRegistrySignature verification using embedded JWK...");
      const commonsDbJwkResult = verifyJwtWithEmbeddedJwk(data.commonsDbRegistrySignature);

      if (commonsDbJwkResult.valid) {
        console.log("[Ingest] commonsDbRegistrySignature verified successfully using embedded JWK");
        console.log("[Ingest] Verified payload:", JSON.stringify(commonsDbJwkResult.payload));
      } else {
        // Fallback to company public key mapping if JWK verification fails
        console.log("[Ingest] commonsDbRegistry JWK verification failed, falling back to company public key mapping");
        console.log("[Ingest] JWK error:", commonsDbJwkResult.error);

        try {
          console.log("[Ingest] commonsDbRegistrySignature verification start (fallback):", companyPublicKey);
          const verificationResult = jwt.verify(data.commonsDbRegistrySignature, companyPublicKey, {
            algorithms: ["ES256"],
          });

          console.log(
            "[Ingest] commonsDbRegistrySignature verification result (fallback):",
            JSON.stringify(verificationResult),
          );
        } catch (e) {
          console.log("[Ingest] commonsDbRegistrySignature decode failed:", JSON.stringify(e));
          if (companyPublicKey) {
            return {
              statusCode: 400,
              body: JSON.stringify({
                error: "CommonsDbRegistry signature verification failed",
                message: "Invalid commonsDbRegistrySignature - both JWK and fallback verification failed",
                jwkError: commonsDbJwkResult.error,
              }),
            };
          }
        }
      }

      if (!data.commonsDbRegistryTsaSignature) {
        console.log("commonsDbRegistryTsaSignature check failed:");
        return {
          statusCode: 400,
          body: "Invalid request body data invalid commonsDbRegistryTsaSignature",
        };
      }

      // ========================================
      // TSA Signature Verification (CommonsDB Registry) - Content Only
      // ========================================
      // Verify the TSA timestamp signature by checking TSQ/TSR content match only
      console.log("[Ingest] Verifying commonsDbRegistry TSA signature (content only)...");
      const commonsDbTsaResult = verifyTsaSignatureContentOnly(
        data.commonsDbRegistryTsaSignature,
        data.commonsDbRegistrySignature,
      );

      if (!commonsDbTsaResult.valid) {
        console.error("[Ingest] CommonsDB TSA signature content verification FAILED");
        console.error(`[Ingest] CommonsDB TSA errors: ${JSON.stringify(commonsDbTsaResult.errors)}`);

        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "CommonsDB TSA signature verification failed",
            message: "The TSA signature content verification failed - TSQ/TSR hash mismatch",
            tsaErrors: commonsDbTsaResult.errors,
            iscc: iscc,
          }),
        };
      }

      console.log("[Ingest] CommonsDB TSA signature content verification PASSED");
    }
  }

  // ========================================
  // Opt-Out Registry Signature Verification (when optOutMetadata is present)
  // ========================================
  if (data.declarationMetadata.optOutMetadata) {
    if (!skipStrictValidation) {
      const optOutSignature = data.optOutRegistrySignature;
      const optOutTsaSignature = data.optOutRegistryTsaSignature;

      if (!optOutSignature || !optOutTsaSignature) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "Opt-out signature verification failed",
            message:
              "optOutRegistrySignature and optOutRegistryTsaSignature are required when optOutMetadata is provided",
            iscc: iscc,
          }),
        };
      }

      // Verify optOutRegistrySignature (JWT of optOutMetadata)
      console.log("[Ingest] Verifying optOutRegistrySignature using embedded JWK...");
      const optOutJwkResult = verifyJwtWithEmbeddedJwk(optOutSignature);

      if (optOutJwkResult.valid) {
        console.log("[Ingest] optOutRegistrySignature verified successfully using embedded JWK");
      } else {
        console.log("[Ingest] optOutRegistry JWK verification failed, falling back to company public key mapping");
        try {
          if (companyPublicKey) {
            jwt.verify(optOutSignature, companyPublicKey, { algorithms: ["ES256"] });
            console.log("[Ingest] optOutRegistrySignature verified using company public key");
          } else {
            return {
              statusCode: 400,
              body: JSON.stringify({
                error: "Opt-out signature verification failed",
                message: "No JWK in JWT header and no registered public key for company",
                jwkError: optOutJwkResult.error,
                iscc: iscc,
              }),
            };
          }
        } catch (e) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: "Opt-out signature verification failed",
              message: "Invalid optOutRegistrySignature - both JWK and fallback verification failed",
              jwkError: optOutJwkResult.error,
              iscc: iscc,
            }),
          };
        }
      }

      // Verify optOutRegistryTsaSignature (TSA of optOutRegistrySignature)
      console.log("[Ingest] Verifying optOutRegistry TSA signature (content only)...");
      const optOutTsaResult = verifyTsaSignatureContentOnly(optOutTsaSignature, optOutSignature);

      if (!optOutTsaResult.valid) {
        console.error("[Ingest] Opt-out TSA signature content verification FAILED");
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "Opt-out TSA signature verification failed",
            message: "The TSA signature content verification failed - TSQ/TSR hash mismatch",
            tsaErrors: optOutTsaResult.errors,
            iscc: iscc,
          }),
        };
      }
      console.log("[Ingest] Opt-out TSA signature content verification PASSED");
    }
  }

  const [fieldKey, fieldValue, generatedValue] = getIdentifierKeyValuePair(
    data?.metaInternal,
    data?.declarationMetadata?.publicMetadata,
  );

  if (fieldValue) {
    if (fieldValue !== generatedValue) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Identifier verification failed",
          message: "Provided identifier does not match the content",
          provided: data.metaInternal[fieldKey as IdentifierFieldValuesType],
          expected: generatedValue,
        }),
      };
    }
  }

  //@ts-ignore
  data.metaInternal[fieldKey as IdentifierFieldValuesType] = generatedValue;
  if (data.declarationMetadata.commonsDbRegistry) {
    const commonsDbRegistry = data.declarationMetadata.commonsDbRegistry;

    // Validate commonsDbRegistry timestamp is within 60 seconds of server time
    console.log("[Ingest] Checking commonsDbRegistry timestamp...");
    if (commonsDbRegistry.timestamp) {
      const timestampCheck = isTimestampWithin60Seconds(commonsDbRegistry.timestamp, ingestStartTime);
      if (!timestampCheck.valid) {
        console.log("commonsDbRegistry.timestamp check failed:", timestampCheck.error);
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "CommonsDB Registry timestamp validation failed",
            message: timestampCheck.error,
            providedTimestamp: commonsDbRegistry.timestamp,
            serverTime: ingestStartTime,
            iscc: iscc,
          }),
        };
      }
      console.log("[Ingest] commonsDbRegistry.timestamp validation PASSED (within 60 seconds)");
    }
  }

  // CRITICAL: Create pending status BEFORE sending to Kinesis to avoid race condition
  // The processor might complete before we create the status, causing "not found" errors
  let statusCreated = false;
  if (generatedValue) {
    try {
      await createPendingDeclarationStatus(generatedValue);
      statusCreated = true;
      console.log("Created pending declaration status for identifier:", generatedValue);
    } catch (statusError) {
      console.error("Failed to create pending declaration status (will retry after send):", statusError);
      // Continue with sending - we'll try again after
    }
  }

  const { success, rayId } = await sendRecord(data!);
  if (!success) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Failed to ingest", rayId }),
    };
  }
  console.log("end of ingest sending response");

  // If status wasn't created before sending, try again now (fallback for retry scenarios)
  if (generatedValue && !statusCreated) {
    try {
      await createPendingDeclarationStatus(generatedValue);
      statusCreated = true;
      console.log("Created pending declaration status (retry) for identifier:", generatedValue);
    } catch (statusError) {
      console.error("Failed to create pending declaration status on retry (non-blocking):", statusError);
      // Continue even if status creation fails - processor will handle missing status
    }
  }

  return {
    statusCode: 202,
    body: JSON.stringify({
      rayId,
      message: statusCreated ? "accepted and pending" : "accepted and pending, tracking may be delayed",
      env: Config.STAGE,
      iscc,
      [fieldKey]: generatedValue,
      version: Config.VERSION,
    }),
  };
});
