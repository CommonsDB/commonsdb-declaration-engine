import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";
import { getMultipleJsonsFromS3ByPath } from "@commonsdb/core/searchUtils/s3Util";
import { Bucket } from "sst/node/bucket";
import { IS3PathMap, getLatest100S3Paths } from "@commonsdb/core/searchUtils/tableVectorDataUtil";
import { IDeclarationPayload } from "@commonsdb/core/interfaces/commonInterfaces";
import {
  getIsRedactedByDeclarationIds,
  getIsRedactedByIdentifiers,
  getIsRedactedProductByProductIds,
} from "@commonsdb/core/searchUtils/tableRedactedUtil";
import { getIdentifierKeyValuePair, IdentifierFieldValuesType } from "@commonsdb/core/utils/fieldMapping";
// import

export const getLatest = ApiHandler(async (_evt) => {
  console.log("getLatest called: ");
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }
  console.log(Config.VERSION);

  console.log(`getLatest: retrieving 100 latest declarations from DynamoDB by timestamp`);
  const s3Paths: IS3PathMap[] = await getLatest100S3Paths();
  console.log(
    "s3Paths from DynamoDB (ordered by timestamp)",
    JSON.stringify(
      s3Paths.map((p) => ({
        s3MapItemId: p.s3MapItemId,
        timestamp: p.timestamp ? new Date(p.timestamp).toISOString() : "unknown",
        s3Path: p.s3Path,
      })),
      null,
      2,
    ),
  );

  if (s3Paths.length === 0) {
    const willReturn = {
      statusCode: 200,
      body: JSON.stringify(
        {
          q: "latest",
          hashBits: "",
          invalidCount: 0,
          version: Config.VERSION,
          results: [],
        },
        null,
        2,
      ),
    };
    console.log("will return:", willReturn);
    return willReturn;
  }

  console.log("get multiple jsons from s3 by path", s3Paths);
  const s3ResultsWithDocBody: IS3PathMap[] = await getMultipleJsonsFromS3ByPath(s3Paths);
  // returns "{"s3Path":"s3://dev-commonsdb-declaration-data/aaaa/ISCC:KEC6SQBQRPU4GKGDVWTMQNJQXWOI5ZO3Y2WN7AAYQTUMB5ERDIYHXPI/ISCC:KEC6SQBQRPU4GKGDVWTMQNJQXWOI5ZO3Y2WN7AAYQTUMB5ERDIYHXPI.json"}"
  // attach metadata to results:
  for (let i = 0; i < s3ResultsWithDocBody.length; i++) {
    // SAFETY CHECKS
    if (s3ResultsWithDocBody[i] === undefined) {
      console.log("ERROR: s3result is undefined for s3 document i: ", i, s3ResultsWithDocBody);
      continue;
    }
    if (s3ResultsWithDocBody[i].docBody === undefined) {
      console.log("ERROR: s3DocBody is undefined for s3 document i: ", i, s3ResultsWithDocBody);
      continue;
    }

    const s3DocBody = s3ResultsWithDocBody[i].docBody;
    if (!s3DocBody.metaInternal) {
      s3DocBody.metaInternal = {};
    }
    // metaInternal now always exists
    s3DocBody.metaInternal.vectorDbId = s3ResultsWithDocBody[i].s3MapItemId;
    s3DocBody.metaInternal.s3path = s3Paths[i].s3Path;
    s3DocBody.metaInternal.s3bucket = Bucket.declarationData.bucketName;
  }

  const [fieldKey] = getIdentifierKeyValuePair();

  const onlyValidResults = s3ResultsWithDocBody.filter((doc) => doc !== undefined);
  const sortedByScoreAscending = onlyValidResults.sort((a, b) => {
    if (a.score > b.score) {
      return 1;
    }
    if (a.score < b.score) {
      return -1;
    }
    return 0;
  });
  console.log("getLatest results: (valid)", sortedByScoreAscending.length, "of total", s3ResultsWithDocBody.length);

  function deduplicateArrayByField(arr: any[]): any[] {
    const uniqueFieldValues = new Set();

    return arr.filter((id) => {
      if (uniqueFieldValues.has(id)) {
        return false;
      } else {
        uniqueFieldValues.add(id);
        return true;
      }
    });
  }

  const areRedactedProductMap = await getIsRedactedProductByProductIds(
    deduplicateArrayByField(
      sortedByScoreAscending
        .map((r: IS3PathMap) => r.docBody.declarationMetadata.publicMetadata.entryUUID || "")
        .filter((i) => !!i),
    ),
  );
  console.log("getLatest redactedProductQueryMap: ", areRedactedProductMap);

  const areRedactedMap = await getIsRedactedByIdentifiers(
    deduplicateArrayByField(
      sortedByScoreAscending.map((r: IS3PathMap) => r.docBody.metaInternal?.[fieldKey] || "").filter((i) => !!i),
    ),
  );
  console.log("getLatest redactedQueryMap: ", areRedactedMap);

  const declarerIdBlacklist = Config.DECLARER_ID_DENYLIST
    ? Config.DECLARER_ID_DENYLIST.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  const CENSORED = sortedByScoreAscending
    .filter(
      (r: IS3PathMap) =>
        new Date(r.docBody.declarationMetadata.publicMetadata.timestamp) > new Date(Config.MIN_DECLARATION_TIMESTAMP),
    ) //Filter declarations by minimum timestamp
    .filter((r: IS3PathMap) => !areRedactedProductMap[r.docBody.declarationMetadata.publicMetadata.entryUUID || ""])
    .filter((r: IS3PathMap) => !areRedactedMap[r.docBody.metaInternal?.[fieldKey] || ""])
    .filter(
      (r: IS3PathMap) =>
        declarerIdBlacklist.length === 0 ||
        !declarerIdBlacklist.includes(r.docBody.declarationMetadata.publicMetadata.declarerId || ""),
    ) //Filter declarations by declarerId denylist
    .map((r: IS3PathMap) => {
      if (r.docBody) {
        const bod: IDeclarationPayload = r.docBody;
        // const [,, generatedValue] = getIdentifierKeyValuePair(bod);

        const censored: IS3PathMap = {
          ...r,
          docBody: {
            ...r.docBody,
            metaInternal: {
              rayId: bod.metaInternal.rayId || "",
              cid: bod.metaInternal.cid || "",
              [fieldKey]: bod.metaInternal[fieldKey as IdentifierFieldValuesType] || "",
              declarationId: bod.metaInternal.declarationId || "",
              isccCode: bod.metaInternal.isccCode || "",
            },
            declarationMetadata: {
              publicMetadata: bod.declarationMetadata.publicMetadata,
              //we might have private metadata here so we need to filter it out
            },
          },
        };
        if (bod.declarationMetadata.commonsDbRegistry) {
          censored.docBody.declarationMetadata.commonsDbRegistry = {
            ...bod.declarationMetadata.commonsDbRegistry,
          };
        }

        return censored;
      }
      return r;
    });

  const willReturn = {
    statusCode: 200,
    body: JSON.stringify(
      {
        q: "latest",
        hashBits: "",
        invalidCount: s3ResultsWithDocBody.length - onlyValidResults.length,
        version: Config.VERSION,
        // results: sortedByScoreAscending,
        results: CENSORED,
      },
      null,
      2,
    ),
  };
  console.log("will return getLatest:", willReturn);
  console.log("custom-logs: ", _evt.headers["custom-log"]);
  return willReturn;
});
