/**
 * Test data generator
 * Creates 100+ variations of test data for comprehensive testing
 */

import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Constants
// ============================================================================

export const SAMPLE_THUMBNAIL =
  "UklGRnIIAABXRUJQVlA4IGYIAAAQJgCdASpXAIAAPrVMoEunJCMhqVkseOAWiUAYg5RCwCKmgGF7ahej3+cdGB6AN4A9ACgZ6ebBhqYeDtC4HqTiyuPvX/Q6IfSCh6e9U58YOChKjhim15HMs5QF5mWEinPxKmGTCmcE7+EDg5xOFiF0vsKHMKvRDIKZ0Cgg6+N8pWbDEWskjz4inhj+a0ZBh0RhnMUlQSii7UiNDW2Wm8qNjZ8h0BGzZY8UpBY5WqRgJIkqQEOcUO/fbOWmKSZe8LET4tyh/OZl5QRHTn/8gEi6Rv16ATC4ApxhAWLmWqzx7lGpeTCHGZcbsqJRNYOK/+qmWFso8r1dqWG8iv6GQaBHzMuv4EjnSG8xQ0R4zceRqm4RrnulcwNq7txQ5rNi8TSp7YJcvfVDpFvROcNYdhainDrWQM8vgOboAP72BmcQY2CDD1zSjLU1gF/nCxb/9vc2e5XoMg9k9cVbD4Uxpsf6Ww2bdpjIGBjfe6WtmXPtUHhgvslLBU677r9iiFtUmFxhT7SiDsMT87yQTKzc5L76OOEh0iPoRi8MrXSoc1ZzNfqvGwfVKmzuO6+X7EbhBuT76fT3wnMkQUcRE1GDS7o5furpLnDb9JFp8gIg6UyA39bQDuH5WERL7YZRly5Hl720X2XXE6nKI8wUVcq2GlZOLxJD+u9DZfZi328+DCMONpQ6v+G7L+0+y+iexlzTt5XB4Z8uv52g4Z/cOhqR5Q0i7yqH1MELq7dYc2O/teC+hqxA9kIp2d48endJ/heWaYp5DPC8k1Iq5nXtVjQIXxe4HCnzMBhs26soTSUsQHjbQEmvM5wRkA/O4159+4BRjWO+3/W0oJkMRueHZUfe2PhxzxeQHGJO/4m+0u65FP+5WAoObuXjmVyGmC+6ZVmIAX9m4WDfxGIdFbuA8UVr+UfbRsgqFnWW1n1GcEox2aM3H028b6JP3/1yRI5YuRRkQh4PdJrbcELN4RXvP71qrCLSzaJKUmGgw9k/jWInftCZQqCU4oIyx0ZhHmm/acz5/q99NhUA01DHMyWhWH17CxiOh3R0MLBQRmMymmu6FrnuB0/UgnX1Sdj/Im+O8YMsDpW68joHYxczJMz5UVAV7udqbIrOFtEF59waVgyXGIMVUCf4Nm8fZtren+JPVow1eEk4BKyD2EalH8i74JlwARnXm9PiaM8vk5ZtJCc4Xg0i5eIXS/lRaufVsh6hqUKUJ7REi3Clvc16y+psFDemA5ZydLn1Gys3dDPCbgWkf58jE2fSUrZUXnAhPs7Wj9m59hB7rhg+kpnUJG5f7Ns4pF6EfOtYJa2IvhQj94btY4+OiR/7Xjrp7IoGYEx4KUtREaxBJXzme3fLeQk3e7ZLKrUwjh56ianKm0WqvDU6t5te6Y8Utr+ui+oOMqSm1B5C1xzTOYT9gV78zxp2QxbhgdoAA==";

export const SAMPLE_CREDENTIAL = {
  id: "urn:uuid:00000000-0000-4000-8000-000000000000",
  type: ["VerifiableCredential", "VerifiableAttestation", "VerifiableSupplier"],
  proof: {
    jwt: "<issuer-signed RS256 JWT verifiable-supplier credential>",
    type: "JwtProof2020",
  },
  issuer: "did:web:issuer.example",
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  validFrom: "2025-07-09T10:56:50.328Z",
  validUntil: "2028-07-09T10:56:50.328Z",
  credentialSchema: [
    {
      id: "https://example.org/schemas/verifiable-supplier.json",
      type: "JsonSchema",
    },
  ],
};

// Valid rights statements
export const VALID_RIGHTS_STATEMENTS = [
  "https://creativecommons.org/publicdomain/mark/1.0/",
  "https://creativecommons.org/publicdomain/zero/1.0/",
  "https://creativecommons.org/licenses/by/4.0/",
  "https://creativecommons.org/licenses/by-sa/4.0/",
  "https://creativecommons.org/licenses/by/3.0/",
  "https://creativecommons.org/licenses/by-sa/3.0/",
  "https://creativecommons.org/licenses/by/3.0/za/",
  "https://creativecommons.org/licenses/by-sa/3.0/za/",
  "https://creativecommons.org/licenses/by/2.5/",
  "https://creativecommons.org/licenses/by-sa/2.5/",
];

// Invalid rights statements for failure tests
export const INVALID_RIGHTS_STATEMENTS = [
  "https://example.com/invalid-license",
  "http://creativecommons.org/licenses/by/4.0/", // http instead of https
  "https://creativecommons.org/licenses/by/5.0/", // non-existent version
  "https://some-random-site.com/license",
  "not-a-url",
  "",
];

// Valid media types
export const VALID_MEDIA_TYPES = [
  "image/webp",
  "image/jpeg",
  "image/png",
  "image/gif",
  "video/mp4",
  "audio/mpeg",
  "application/pdf",
  "text/plain",
];

// Sample names for variety
export const SAMPLE_NAMES = [
  "The Letters Project (Vincent van Gogh)",
  "Digital Archive Collection",
  "European Heritage Document",
  "Historical Photograph Collection",
  "Art Museum Catalogue",
  "Ancient Manuscript Scan",
  "Classical Music Recording",
  "Documentary Film Archive",
  "Scientific Research Data",
  "Cultural Heritage Item",
  "Renaissance Painting High-Res",
  "Medieval Manuscript Page",
  "Archaeological Site Photo",
  "Botanical Illustration",
  "Architectural Blueprint",
  "Portrait Photography Collection",
  "Landscape Painting Series",
  "Sculpture 3D Model",
  "Textile Pattern Archive",
  "Ceramic Art Documentation",
];

// Sample descriptions
export const SAMPLE_DESCRIPTIONS = [
  "A comprehensive digital collection documenting important cultural heritage items.",
  "High-resolution digitization of historical artifacts from the museum collection.",
  "Carefully curated archive of significant cultural and artistic works.",
  "Documentary evidence of important historical events and cultural practices.",
  "Preservation-quality digital copies of rare and valuable materials.",
  "Research-grade documentation of cultural heritage for academic study.",
  "Public domain materials made freely available for education and research.",
  "Open access cultural heritage digitization project materials.",
  "Community contributed cultural documentation and oral histories.",
  "Expert-verified authentic cultural heritage materials.",
];

// Sample stewards
export const SAMPLE_STEWARDS = [
  "European Heritage Awards Archive",
  "National Museum Collection",
  "University Digital Library",
  "Cultural Heritage Foundation",
  "Art History Institute",
  "Archaeological Survey Team",
  "Historical Society Archives",
  "Public Library System",
  "Research University",
  "Cultural Ministry Archive",
];

// ============================================================================
// Helper Functions
// ============================================================================

export function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

export function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function generateIsccCode(): string {
  // Generate a valid-looking ISCC code (55 characters after ISCC: prefix)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let code = "ISCC:";
  for (let i = 0; i < 55; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Counter for unique ISCC generation
let isccCounter = 0;

/**
 * Generate a unique ISCC code for each test to avoid collision with existing assets.
 * Uses timestamp + counter to ensure uniqueness.
 */
export function generateUniqueIsccCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  // Create a unique seed from timestamp + counter
  const seed = Date.now().toString(36).toUpperCase() + (isccCounter++).toString(36).toUpperCase();

  let code = "ISCC:KA"; // Start with valid ISCC prefix for content-code
  // Pad seed to ensure we have enough characters
  const paddedSeed = seed.padEnd(10, "0");

  // Use seed characters where valid, otherwise generate random
  for (let i = 0; i < 53; i++) {
    const seedChar = paddedSeed[i % paddedSeed.length];
    if (chars.includes(seedChar)) {
      code += seedChar;
    } else {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  }
  return code;
}

export function generateInvalidIsccCode(): string {
  // Generate various invalid ISCC formats
  const invalidFormats = [
    "ISCC:" + randomString(10), // Too short
    "ISCC:" + randomString(100), // Too long
    "iscc:" + randomString(55).toUpperCase(), // lowercase prefix
    randomString(55), // No prefix
    "ISCC:" + randomString(55).toLowerCase(), // lowercase code
    "ISCC:" + "12345" + randomString(50), // Contains numbers not in base32
    "ISC:" + randomString(55), // Wrong prefix
    "", // Empty
  ];
  return randomElement(invalidFormats);
}

export function generateDeclarerId(): string {
  return `did:key:z${randomString(80)}`;
}

export function generateInvalidDeclarerId(): string {
  const invalidFormats = [
    "not-a-did",
    "did:" + randomString(20), // Missing method
    randomString(50), // No prefix
    "", // Empty
    "did:invalid:", // Incomplete
    "did:key:", // No identifier
  ];
  return randomElement(invalidFormats);
}

// ============================================================================
// Test Case Generators
// ============================================================================

export interface PublicMetadata {
  $schema: string;
  "@context": string;
  original: string;
  iscc: string;
  name: string;
  description: string;
  mediatype: string;
  thumbnail: string;
  timestamp: number;
  declarerId: string;
  credentials: any[];
  sourceUrl?: string;
  version?: number;
  supersedes?: string;
  supplierMetadata?: {
    location: string;
    name: string;
    description: string;
    steward?: string;
    rightsStatement: string;
  };
}

export interface CommonsDbRegistry {
  location: string;
  rightsStatement: string;
  iscc: string;
  credentials: any[];
  timestamp: number;
}

export interface DeclarationMetadata {
  publicMetadata: PublicMetadata;
  commonsDbRegistry?: CommonsDbRegistry;
}

export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: "valid" | "invalid_schema" | "invalid_format" | "missing_required" | "invalid_values" | "edge_case";
  expectSuccess: boolean;
  expectedError?: string;
  metadata: Partial<DeclarationMetadata>;
}

/**
 * Generate a valid base declaration metadata
 */
export function generateValidDeclarationMetadata(declarerId: string, isccCode: string): DeclarationMetadata {
  const timestamp = Date.now();
  const rightsStatement = randomElement(VALID_RIGHTS_STATEMENTS);

  const credential = {
    ...SAMPLE_CREDENTIAL,
    credentialSubject: {
      id: declarerId,
      sameAs: randomElement(SAMPLE_STEWARDS),
      dataSupplierFor: "registry.commonsdb.org",
    },
  };

  return {
    publicMetadata: {
      $schema: "https://w3id.org/commonsdb/schema/0.2.0.json",
      "@context": "https://w3id.org/commonsdb/context/0.2.0.json",
      original: "https://example.org/items/123",
      iscc: isccCode,
      name: randomElement(SAMPLE_NAMES),
      description: randomElement(SAMPLE_DESCRIPTIONS),
      mediatype: randomElement(VALID_MEDIA_TYPES),
      thumbnail: SAMPLE_THUMBNAIL,
      timestamp,
      declarerId,
      sourceUrl: "https://example.org/items/123",
      version: 1,
      credentials: [credential],
      supplierMetadata: {
        location: "https://example.org/items/123",
        name: randomElement(SAMPLE_NAMES),
        description: randomElement(SAMPLE_DESCRIPTIONS),
        steward: randomElement(SAMPLE_STEWARDS),
        rightsStatement,
      },
    },
    commonsDbRegistry: {
      location: "https://example.org/items/123",
      rightsStatement,
      iscc: isccCode,
      credentials: [{ proof: SAMPLE_CREDENTIAL.proof.jwt }],
      timestamp,
    },
  };
}

/**
 * Generate all test cases (100+)
 */
export function generateAllTestCases(declarerId: string, isccCode: string): TestCase[] {
  const testCases: TestCase[] = [];
  let testId = 1;

  // ============================================================================
  // VALID TEST CASES (20 cases)
  // ============================================================================

  // Basic valid cases with different rights statements
  for (let i = 0; i < 10; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    testCases.push({
      id: `valid-${testId++}`,
      name: `Valid declaration with ${VALID_RIGHTS_STATEMENTS[i % VALID_RIGHTS_STATEMENTS.length]}`,
      description: "Complete valid declaration with all required fields",
      category: "valid",
      expectSuccess: true,
      metadata,
    });
  }

  // Valid cases with different media types
  for (const mediatype of VALID_MEDIA_TYPES.slice(0, 5)) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.mediatype = mediatype;
    testCases.push({
      id: `valid-${testId++}`,
      name: `Valid declaration with mediatype ${mediatype}`,
      description: "Valid declaration with specific media type",
      category: "valid",
      expectSuccess: true,
      metadata,
    });
  }

  // Valid cases without optional commonsDbRegistry
  for (let i = 0; i < 5; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete metadata.commonsDbRegistry;
    testCases.push({
      id: `valid-${testId++}`,
      name: `Valid declaration without commonsDbRegistry #${i + 1}`,
      description: "Valid declaration without optional registry data",
      category: "valid",
      expectSuccess: true,
      metadata,
    });
  }

  // ============================================================================
  // MISSING REQUIRED FIELDS (30 cases)
  // ============================================================================

  // Missing $schema
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any)["$schema"];
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing $schema field #${i + 1}`,
      description: "Declaration without required $schema field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "$schema",
      metadata,
    });
  }

  // Missing @context
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any)["@context"];
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing @context field #${i + 1}`,
      description: "Declaration without required @context field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "@context",
      metadata,
    });
  }

  // Missing original
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).original;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing original field #${i + 1}`,
      description: "Declaration without required original field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "original",
      metadata,
    });
  }

  // Missing iscc
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).iscc;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing iscc field #${i + 1}`,
      description: "Declaration without required iscc field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "iscc",
      metadata,
    });
  }

  // Missing name
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).name;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing name field #${i + 1}`,
      description: "Declaration without required name field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "name",
      metadata,
    });
  }

  // Missing timestamp
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).timestamp;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing timestamp field #${i + 1}`,
      description: "Declaration without required timestamp field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "timestamp",
      metadata,
    });
  }

  // Missing declarerId
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).declarerId;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing declarerId field #${i + 1}`,
      description: "Declaration without required declarerId field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "declarerId",
      metadata,
    });
  }

  // Missing credentials
  for (let i = 0; i < 3; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete (metadata.publicMetadata as any).credentials;
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing credentials field #${i + 1}`,
      description: "Declaration without required credentials field",
      category: "missing_required",
      expectSuccess: false,
      expectedError: "credentials",
      metadata,
    });
  }

  // Missing multiple required fields
  for (let i = 0; i < 6; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    const fieldsToDelete = ["$schema", "@context", "iscc", "name", "timestamp", "declarerId"];
    delete (metadata.publicMetadata as any)[fieldsToDelete[i]];
    delete (metadata.publicMetadata as any)[fieldsToDelete[(i + 1) % fieldsToDelete.length]];
    testCases.push({
      id: `missing-${testId++}`,
      name: `Missing multiple fields combination #${i + 1}`,
      description: "Declaration missing multiple required fields",
      category: "missing_required",
      expectSuccess: false,
      metadata,
    });
  }

  // ============================================================================
  // INVALID FORMAT TEST CASES (25 cases)
  // ============================================================================

  // Invalid ISCC format
  for (let i = 0; i < 5; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.iscc = generateInvalidIsccCode();
    testCases.push({
      id: `invalid-format-${testId++}`,
      name: `Invalid ISCC format #${i + 1}`,
      description: "Declaration with invalid ISCC code format",
      category: "invalid_format",
      expectSuccess: false,
      expectedError: "iscc",
      metadata,
    });
  }

  // Invalid declarerId format
  for (let i = 0; i < 5; i++) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.declarerId = generateInvalidDeclarerId();
    testCases.push({
      id: `invalid-format-${testId++}`,
      name: `Invalid declarerId format #${i + 1}`,
      description: "Declaration with invalid DID format",
      category: "invalid_format",
      expectSuccess: false,
      expectedError: "declarerId",
      metadata,
    });
  }

  // Invalid timestamp format
  const invalidTimestamps = ["not-a-number", -1, 0, NaN, Infinity];
  for (const invalidTs of invalidTimestamps) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    (metadata.publicMetadata as any).timestamp = invalidTs;
    testCases.push({
      id: `invalid-format-${testId++}`,
      name: `Invalid timestamp: ${invalidTs}`,
      description: "Declaration with invalid timestamp value",
      category: "invalid_format",
      expectSuccess: false,
      expectedError: "timestamp",
      metadata,
    });
  }

  // Invalid $schema URL
  const invalidUrls = ["not-a-url", "ftp://invalid-protocol.com", "", "javascript:alert(1)", "file:///etc/passwd"];
  for (const invalidUrl of invalidUrls) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata["$schema"] = invalidUrl;
    testCases.push({
      id: `invalid-format-${testId++}`,
      name: `Invalid $schema URL: ${invalidUrl.substring(0, 30)}`,
      description: "Declaration with invalid $schema URL",
      category: "invalid_format",
      expectSuccess: false,
      expectedError: "$schema",
      metadata,
    });
  }

  // Invalid @context URL
  for (const invalidUrl of invalidUrls) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata["@context"] = invalidUrl;
    testCases.push({
      id: `invalid-format-${testId++}`,
      name: `Invalid @context URL: ${invalidUrl.substring(0, 30)}`,
      description: "Declaration with invalid @context URL",
      category: "invalid_format",
      expectSuccess: false,
      expectedError: "@context",
      metadata,
    });
  }

  // ============================================================================
  // INVALID VALUES TEST CASES (20 cases)
  // ============================================================================

  // Invalid rights statements
  for (const invalidRights of INVALID_RIGHTS_STATEMENTS) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    if (metadata.commonsDbRegistry) {
      metadata.commonsDbRegistry.rightsStatement = invalidRights;
    }
    testCases.push({
      id: `invalid-value-${testId++}`,
      name: `Invalid rightsStatement: ${invalidRights.substring(0, 40)}`,
      description: "Declaration with invalid rights statement URL",
      category: "invalid_values",
      expectSuccess: false,
      expectedError: "rightsStatement",
      metadata,
    });
  }

  // Empty string values for required fields
  const requiredStringFields = ["name", "iscc", "declarerId"];
  for (const field of requiredStringFields) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    (metadata.publicMetadata as any)[field] = "";
    testCases.push({
      id: `invalid-value-${testId++}`,
      name: `Empty string for ${field}`,
      description: `Declaration with empty ${field}`,
      category: "invalid_values",
      expectSuccess: false,
      expectedError: field,
      metadata,
    });
  }

  // Whitespace-only values
  for (const field of requiredStringFields) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    (metadata.publicMetadata as any)[field] = "   ";
    testCases.push({
      id: `invalid-value-${testId++}`,
      name: `Whitespace-only ${field}`,
      description: `Declaration with whitespace-only ${field}`,
      category: "invalid_values",
      expectSuccess: false,
      expectedError: field,
      metadata,
    });
  }

  // Wrong type values
  const wrongTypeTests = [
    { field: "timestamp", value: "string-instead-of-number" },
    { field: "credentials", value: "string-instead-of-array" },
    { field: "version", value: "not-a-number" },
    { field: "name", value: 12345 },
    { field: "iscc", value: { object: "instead-of-string" } },
  ];
  for (const test of wrongTypeTests) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    (metadata.publicMetadata as any)[test.field] = test.value;
    testCases.push({
      id: `invalid-value-${testId++}`,
      name: `Wrong type for ${test.field}`,
      description: `Declaration with wrong type for ${test.field}`,
      category: "invalid_values",
      expectSuccess: false,
      expectedError: test.field,
      metadata,
    });
  }

  // ============================================================================
  // EDGE CASES (15 cases)
  // ============================================================================

  // Very long name
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.name = "A".repeat(10000);
    testCases.push({
      id: `edge-${testId++}`,
      name: "Very long name (10000 chars)",
      description: "Declaration with extremely long name",
      category: "edge_case",
      expectSuccess: true, // Should still work
      metadata,
    });
  }

  // Very long description
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.description = "B".repeat(50000);
    testCases.push({
      id: `edge-${testId++}`,
      name: "Very long description (50000 chars)",
      description: "Declaration with extremely long description",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  // Unicode characters in name
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.name = "Тест документ 测试文档 🎨 Αρχείο";
    testCases.push({
      id: `edge-${testId++}`,
      name: "Unicode characters in name",
      description: "Declaration with various Unicode characters",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  // Special characters in description
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.description =
      'Test with <script>alert("xss")</script> and "quotes" and \'apostrophes\' and \\ backslashes';
    testCases.push({
      id: `edge-${testId++}`,
      name: "Special characters in description",
      description: "Declaration with special/dangerous characters",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  // Timestamp far in the past (should fail 60-second window)
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.timestamp = Date.now() - 120000; // 2 minutes ago
    testCases.push({
      id: `edge-${testId++}`,
      name: "Timestamp 2 minutes in past",
      description: "Declaration with timestamp outside 60-second window",
      category: "edge_case",
      expectSuccess: false,
      expectedError: "timestamp",
      metadata,
    });
  }

  // Timestamp in the future (should fail 60-second window)
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.timestamp = Date.now() + 120000; // 2 minutes in future
    testCases.push({
      id: `edge-${testId++}`,
      name: "Timestamp 2 minutes in future",
      description: "Declaration with timestamp in the future",
      category: "edge_case",
      expectSuccess: false,
      expectedError: "timestamp",
      metadata,
    });
  }

  // Empty credentials array
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.credentials = [];
    testCases.push({
      id: `edge-${testId++}`,
      name: "Empty credentials array",
      description: "Declaration with empty credentials array",
      category: "edge_case",
      expectSuccess: false,
      expectedError: "credentials",
      metadata,
    });
  }

  // Null values
  const nullTests = ["name", "description", "iscc"];
  for (const field of nullTests) {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    (metadata.publicMetadata as any)[field] = null;
    testCases.push({
      id: `edge-${testId++}`,
      name: `Null value for ${field}`,
      description: `Declaration with null ${field}`,
      category: "edge_case",
      expectSuccess: false,
      expectedError: field,
      metadata,
    });
  }

  // Very large version number
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    metadata.publicMetadata.version = Number.MAX_SAFE_INTEGER;
    testCases.push({
      id: `edge-${testId++}`,
      name: "Very large version number",
      description: "Declaration with MAX_SAFE_INTEGER version",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  // Duplicate credentials
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    const cred = metadata.publicMetadata.credentials[0];
    metadata.publicMetadata.credentials = [cred, cred, cred];
    testCases.push({
      id: `edge-${testId++}`,
      name: "Duplicate credentials",
      description: "Declaration with duplicate credentials",
      category: "edge_case",
      expectSuccess: true, // Should still work
      metadata,
    });
  }

  // Missing optional supplierMetadata
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete metadata.publicMetadata.supplierMetadata;
    testCases.push({
      id: `edge-${testId++}`,
      name: "Missing optional supplierMetadata",
      description: "Declaration without supplierMetadata",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  // All optional fields missing
  {
    const metadata = generateValidDeclarationMetadata(declarerId, isccCode);
    delete metadata.publicMetadata.sourceUrl;
    delete metadata.publicMetadata.version;
    delete metadata.publicMetadata.supersedes;
    delete metadata.publicMetadata.supplierMetadata;
    delete metadata.commonsDbRegistry;
    testCases.push({
      id: `edge-${testId++}`,
      name: "All optional fields missing",
      description: "Declaration with only required fields",
      category: "edge_case",
      expectSuccess: true,
      metadata,
    });
  }

  return testCases;
}

/**
 * Generate test cases filtered by category
 */
export function getTestCasesByCategory(testCases: TestCase[], category: TestCase["category"]): TestCase[] {
  return testCases.filter((tc) => tc.category === category);
}

/**
 * Generate test cases for success scenarios only
 */
export function getSuccessTestCases(testCases: TestCase[]): TestCase[] {
  return testCases.filter((tc) => tc.expectSuccess);
}

/**
 * Generate test cases for failure scenarios only
 */
export function getFailureTestCases(testCases: TestCase[]): TestCase[] {
  return testCases.filter((tc) => !tc.expectSuccess);
}
