import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { countTotalValidDeclarationsInBucket } from "@commonsdb/core/searchUtils/s3Util";
import { countIdentifiersOfDeclarationRecords } from "@commonsdb/core/searchUtils/tableDeclarationIdsUtil";

export const getFullDeclarationsAmount = ApiHandler(async (_evt) => {
  console.log("getFullDeclarationsAmount called: ");

  // Authentication check
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  console.log(Config.VERSION);

  try {
    console.log("Starting to count total valid declarations in S3 bucket and IdentifiersOfDeclaration table");

    // Count both S3 declarations and DynamoDB table records in parallel
    const [tableRecordsCount] = await Promise.all([
      // countTotalValidDeclarationsInBucket(),
      countIdentifiersOfDeclarationRecords(),
    ]);

    const response = {
      statusCode: 200,
      body: JSON.stringify({
        // total_declarations_s3: totalDeclarationsCount,
        total_declarations_table: tableRecordsCount,
        // difference: Math.abs(totalDeclarationsCount - tableRecordsCount),
        version: Config.VERSION,
      }),
    };

    console.log("will return:", response);
    return response;
  } catch (error) {
    console.error("Error counting total declarations:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error while counting total declarations",
        version: Config.VERSION,
      }),
    };
  }
});
