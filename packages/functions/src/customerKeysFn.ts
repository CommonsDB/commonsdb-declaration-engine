import { Config } from "sst/node/config";
import { generateKeyIfMissing, getDecryptedKeyInternal } from "@commonsdb/core/customer-keys/customerKeys";

/**
 * Both routes handle customer API-key material, so they require the shared
 * gateway access key (`x-api-key === SECRET_ZUPLO_ACCESS_KEY`). Returns null on
 * success, or the 401 response to short-circuit with.
 */
function requireApiKey(_evt: any) {
  const apiKey = _evt.headers?.["x-api-key"];
  if (!apiKey || apiKey !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }
  return null;
}

export async function generateKey(_evt: any, _ctx: any) {
  const unauthorized = requireApiKey(_evt);
  if (unauthorized) return unauthorized;

  try {
    if (!_evt.body) {
      return { statusCode: 400, body: "Invalid request body" };
    }

    const body = JSON.parse(await _evt.body);
    if (!body.customerId) {
      return { statusCode: 400, body: "Missing customerId in request body" };
    }

    const result = await generateKeyIfMissing(body.customerId);
    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error(">> Error generating key:", err);
    return { statusCode: 500, body: "Error generating key" };
  }
}

export async function getDecryptedKey(_evt: any, _ctx: any) {
  const unauthorized = requireApiKey(_evt);
  if (unauthorized) return unauthorized;

  const customerId = _evt.headers?.["x-customer-id"];
  if (!customerId) {
    return { statusCode: 400, body: "Missing x-customer-id header" };
  }

  try {
    const foundKey = await getDecryptedKeyInternal(customerId);
    if (!foundKey) {
      return { statusCode: 404, body: "Key not found" };
    }
    return {
      statusCode: 200,
      body: JSON.stringify(foundKey),
    };
  } catch (err) {
    console.error(">> Error retrieving key:", err);
    return { statusCode: 500, body: "Error retrieving key" };
  }
}
