import { getIdentifierKeyValuePair } from "@commonsdb/core/utils/fieldMapping";
import { getContentByIdentifier } from "@commonsdb/core/searchUtils/tableCidsUtil";
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";

// Looks up a declaration by its identifier and returns the publicMetadata
// content stored for it, straight from the CIDs table.
export const getByDecId = ApiHandler(async (_evt) => {
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  const [fieldKey] = getIdentifierKeyValuePair();
  const fieldValue = _evt.queryStringParameters?.[fieldKey];
  if (!fieldValue) {
    return { statusCode: 400, body: `Invalid request (missing ${fieldKey})` };
  }

  try {
    const { content, cid } = await getContentByIdentifier(fieldValue);
    if (!content) {
      return { statusCode: 404, body: "Not found" };
    }
    return { statusCode: 200, body: content, headers: { "x-cid-header": cid } };
  } catch (err) {
    console.error("Error getting content by identifier:", err);
    throw err;
  }
});
