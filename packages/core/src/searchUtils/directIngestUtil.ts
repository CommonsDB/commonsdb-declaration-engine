import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Table } from "sst/node/table";
import { createHash } from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export interface DirectIngestRegistration {
  /** The did:key identifier — acts as the primary key and uniquely scopes the API key. */
  declarerId: string;
  /** SHA-256 hex digest of the raw API key. Never store the raw key. */
  apiKeyHash: string;
  /**
   * JSON-stringified JWK of the public key associated with the declarerId.
   * Used to validate that the embedded JWK in every incoming JWT matches the
   * registered key (x and y coordinates for P-256 / ES256).
   */
  publicKeyJwk: string;
  isActive: boolean;
  createdAt: string;
  /**
   * Optional comma-separated list of IPv4/IPv6 addresses allowed to use this
   * registration.  Leave empty / omit to allow all IPs.
   */
  allowedIps?: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Look up a registration by declarerId (did:key).
 * Returns null when no registration exists.
 */
export async function getDirectIngestRegistration(declarerId: string): Promise<DirectIngestRegistration | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: Table.directIngestRegistrations.tableName,
      Key: { declarerId },
    }),
  );

  if (!result.Item) return null;
  return result.Item as DirectIngestRegistration;
}

/**
 * Upsert a registration.  The caller is responsible for hashing the apiKey
 * before storing (use `hashApiKey`).
 */
export async function putDirectIngestRegistration(registration: DirectIngestRegistration): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: Table.directIngestRegistrations.tableName,
      Item: registration,
    }),
  );
}

/**
 * Deactivate a registration by setting isActive = false.
 */
export async function deactivateDirectIngestRegistration(declarerId: string): Promise<void> {
  const existing = await getDirectIngestRegistration(declarerId);
  if (!existing) return;
  await putDirectIngestRegistration({ ...existing, isActive: false });
}

/**
 * Hard-delete a registration (use with care — prefer deactivate).
 */
export async function deleteDirectIngestRegistration(declarerId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: Table.directIngestRegistrations.tableName,
      Key: { declarerId },
    }),
  );
}

/**
 * Compare two P-256 JWKs by their key material only (kty, crv, x, y).
 * Returns true when the keys are equivalent.
 */
export function jwksMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;
}
