import { getIdentifierKeyValuePair } from "@commonsdb/core/utils/fieldMapping";
import { getContentByIdentifier } from "@commonsdb/core/searchUtils/tableCidsUtil";
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";

// requires getting an ISCC based on companyID and ISCC code ,
// returns only the publicMetadata from s3 directly
export const getByIdentifier = ApiHandler(async (_evt) => {
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  console.log(Config.VERSION);
  console.log("STAGE", Config.STAGE);
  const [fieldKey] = getIdentifierKeyValuePair();
  const fieldValue = _evt.queryStringParameters?.[fieldKey];
  console.log("identifier", fieldKey, fieldValue);
  if (!fieldValue) {
    return { statusCode: 400, body: `Invalid request (missing ${fieldKey})` };
  }

  try {
    //get directly from dynamo:
    // const content = await Promise.resolve({ statusCode: 200, body: { messageFromServer: "hello ", idPassed: decId } });

    const { content, cid } = await getContentByIdentifier(fieldValue);
    if (!content) {
      return { statusCode: 404, body: "Not found" };
    }
    return { statusCode: 200, body: content, headers: { "x-cid-header": cid } };
  } catch (err) {
    console.error("Error getting from S3:", err);
    throw err;
  }
});
