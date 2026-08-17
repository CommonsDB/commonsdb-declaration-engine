import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { Config } from "sst/node/config";
import { Table } from "sst/node/table";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// get sst node secret
const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
const ivLength = 16; // AES block size in bytes

export interface CustomerKey {
  customerId: string;
  apiKey: string;
}

// Function to generate and store a new key for a customer
export async function generateKeyIfMissing(customerId: string): Promise<CustomerKey> {
  if (!customerId.trim()) {
    throw new Error("customerId cannot be empty");
  }

  // Check if a key already exists for the customer
  const existingKey = await getDecryptedKeyInternal(customerId);
  if (existingKey) {
    // If a key exists, return it instead of creating a new one
    return { customerId, apiKey: existingKey };
  }

  // Generate and store a new key for a customer if no key exists
  const unencryptedKey = randomBytes(32).toString("hex");
  const encryptedKey = encrypt(unencryptedKey);

  const params = {
    TableName: Table.customerKeys.tableName,
    Item: {
      customerId,
      encryptedKey,
    },
  };

  await docClient.send(new PutCommand(params));

  return { customerId, apiKey: unencryptedKey };
}

// Function to retrieve and decrypt a customer's key
export async function getEncryptedKey(customerId: string): Promise<string | null> {
  if (!customerId.trim()) {
    throw new Error("customerId cannot be empty");
  }

  const params = {
    TableName: Table.customerKeys.tableName,
    Key: { customerId },
  };

  const { Item } = await docClient.send(new GetCommand(params));

  if (!Item) return null;

  return Item.encryptedKey;
}
export async function getDecryptedKeyInternal(customerId: string): Promise<string | null> {
  const encryptedKey = await getEncryptedKey(customerId);
  if (!encryptedKey || encryptedKey === "") return null;

  const decryptedKey = decrypt(encryptedKey);
  return decryptedKey;
}

// Helper function to encrypt a key
function encrypt(text: string): string {
  const iv = randomBytes(ivLength);
  // Ensure the encryptionKey is a Buffer of 32 bytes
  const keyBuffer = Buffer.from(encryptionKey, "hex");
  const cipher = createCipheriv("aes-256-cbc", keyBuffer, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

// Helper function to decrypt a key
function decrypt(text: string): string {
  const textParts = text.split(":");
  const iv = Buffer.from(textParts.shift()!, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  // Ensure the encryptionKey is a Buffer of 32 bytes
  const keyBuffer = Buffer.from(encryptionKey, "hex");
  const decipher = createDecipheriv("aes-256-cbc", keyBuffer, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}
