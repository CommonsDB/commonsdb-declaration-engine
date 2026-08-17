import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { createISCCFromUrl } from "@commonsdb/core/isccGen/generatorUtil";

export const IsccFromUrl = ApiHandler(async (_evt) => {
  if (_evt.requestContext.http.method !== "GET") {
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

  // get srcUrl from query params
  const srcUrl = _evt.queryStringParameters?.srcUrl;
  if (!srcUrl) {
    return {
      statusCode: 400,
      body: "Missing srcUrl query parameter",
    };
  }

  const iscc = await createISCCFromUrl(srcUrl);

  return {
    statusCode: 200,
    body: JSON.stringify(iscc),
  };
});
