import { GetObjectCommand, PutObjectCommand, S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Bucket } from "sst/node/bucket";
import { Config } from "sst/node/config";
import { IS3PathMap } from "./tableVectorDataUtil";
import { getIdentifierKeyValuePair } from "../utils/fieldMapping";

export interface IJsonSaveToS3Info {
  isccCode: string;
  companyId: string;
  rayId: string;
  mappingInfo: {
    mapKey: string;
    attribute: string;
    table: string;
    db: "dynamodb" | "other";
  };
  vectorInfo: {
    /** Opaque item id returned by the search service (key in vectorToDataMap). */
    id: string;
    storageDb: "search-service" | "other";
    storageHost: string;
  };
  data: any;
}
function createS3Client(): S3Client {
  return new S3Client({});
}
export async function getMultipleJsonsFromS3ByPath(s3Paths: IS3PathMap[]): Promise<any[]> {
  try {
    const queryAllObjects = async () => {
      return await Promise.all(s3Paths.map((item) => getJsonFromS3ByPath(item)));
    };
    const results = await queryAllObjects();
    return results;
  } catch (err) {
    console.error("Error getting from S3:", err);
    throw err;
  }
}
function cleans3Path(s3Path: string): string {
  return s3Path
    .replace("s3://", "")
    .replace("S3://", "")
    .replace(Bucket.declarationData.bucketName + "/", "");
}

export async function getJsonFromS3ByPath(item: IS3PathMap): Promise<IS3PathMap> {
  try {
    const s3 = createS3Client();
    const data = await s3.send(
      new GetObjectCommand({
        Bucket: Bucket.declarationData.bucketName,
        Key: cleans3Path(item.s3Path),
      }),
    );
    // console.log('>>>Successfully read from S3.. RAW:', data);
    // read file from ody buffer
    const bodyBuffer = await data.Body?.transformToString();
    const docBody = JSON.parse(bodyBuffer!);
    return {
      score: item.score,
      s3MapItemId: item.s3MapItemId,
      keyId: item.keyId,
      s3Path: item.s3Path,
      status: "success",
      docBody,
    };
  } catch (err) {
    console.error("Error getting from S3:", err);
    return {
      score: -1,
      s3MapItemId: item.s3MapItemId,
      keyId: item.keyId,
      s3Path: item.s3Path,
      docBody: { err },
      status: "error",
    };
    // throw err;
  }
}

function generateS3Path(companyId: string, isccCode: string, identifier: string): string {
  // example URL:   "commonsdb.org/ISCC:KAC5ZTLK33HL252ZMNALXJHBLB7X7EWL2BGVCVO4M3IS7TG77DWGWUY/ISCC:KAC5ZTLK33HL252ZMNALXJHBLB7X7EWL2BGVCVO4M3IS7TG77DWGWUY.json"
  // should output: "commonsdb.org/ISCC:KECVUW6HGOBFOAUIX7R4AH3BMEPMC4AN3FBR3KCON3OGXPGYZKHH3ZI/ISCC:KECVUW6HGOBFOAUIX7R4AH3BMEPMC4AN3FBR3KCON3OGXPGYZKHH3ZI.json"
  const uriV1 = `${companyId}/${isccCode}/${identifier}.json`;
  console.log("Generated S3 path:", uriV1);
  // replace ":" with uri safe version
  return uriV1;
}

export async function saveJsonToS3(info: IJsonSaveToS3Info): Promise<string> {
  try {
    const [, fieldValue] = getIdentifierKeyValuePair(info?.data?.metaInternal);
    console.log("3) Saving to S3..");
    const filePath = generateS3Path(info.companyId, info.isccCode, fieldValue || "missing-identifier");
    console.log(">>>Writing to S3..", filePath);
    const s3 = createS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: Bucket.declarationData.bucketName,
        Key: filePath,
        Body: JSON.stringify(info.data),
        ContentType: "application/json",
      }),
    );
    console.log(">>>Successfully wrote to S3..", filePath);
    return `s3://${Bucket.declarationData.bucketName}/${filePath}`;
  } catch (err) {
    console.error("Error saving to S3:", err);
    throw err;
  }
}

export async function getPublicJsonFromS3(companyId: string, isccCode: string, identifier: string): Promise<any> {
  try {
    const s3 = createS3Client();
    const s3Path = generateS3Path(companyId, isccCode, identifier);
    const data = await s3.send(
      new GetObjectCommand({
        Bucket: Bucket.declarationData.bucketName,
        Key: s3Path,
      }),
    );
    const bodyBuffer = await data.Body?.transformToString();
    const parsedJson = JSON.parse(bodyBuffer!);
    const toReturn = parsedJson.declarationMetadata?.publicMetadata || {};
    toReturn.found = true;
    return toReturn;
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      console.error("S3 Key not found:", err);
      return {
        found: false,
      };
    }
    console.error("Error getting from S3:", err);
    throw err;
  }
}

export interface DeclarerIsccStats {
  declarerId: string;
  uniqueIsccCount: number;
  totalDeclarations: number;
  // isccCodes: string[];
}

export interface UniqueIsccByDeclarerResponse {
  declarerStats: DeclarerIsccStats[];
  totalUniqueIscc: number;
  totalDeclarations: number;
}

export async function countUniqueIsccCodesByDeclarer(): Promise<UniqueIsccByDeclarerResponse> {
  try {
    const s3 = createS3Client();
    const bucketName = Bucket.declarationData.bucketName;
    console.log(`Counting unique ISCC codes by declarer in bucket: ${bucketName}`);

    // Map to store unique ISCC codes per declarerId
    const declarerIsccMap = new Map<string, Set<string>>();
    // Map to store total declarations count per declarerId
    const declarerDeclarationCount = new Map<string, number>();

    // List all objects in the bucket
    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
        MaxKeys: 5000, // Process in batches of 5000
      });

      const response = await s3.send(listCommand);

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            // Parse the S3 key structure: declarerId/ISCC_CODE/file.json
            const pathParts = object.Key.split("/");

            // We need at least 3 parts: declarerId, ISCC_CODE, filename
            if (pathParts.length >= 3) {
              const declarerId = pathParts[0];
              const isccCode = pathParts[1];
              const fileName = pathParts[2];

              // Only count valid ISCC codes and JSON files (skip empty or invalid paths)
              if (declarerId && isccCode && isccCode.startsWith("ISCC:") && fileName.endsWith(".json")) {
                // Initialize Set for this declarer if not exists
                if (!declarerIsccMap.has(declarerId)) {
                  declarerIsccMap.set(declarerId, new Set<string>());
                }

                // Initialize counter for this declarer if not exists
                if (!declarerDeclarationCount.has(declarerId)) {
                  declarerDeclarationCount.set(declarerId, 0);
                }

                // Add ISCC code to the declarer's set (for unique count)
                declarerIsccMap.get(declarerId)!.add(isccCode);

                // Increment total declarations count
                declarerDeclarationCount.set(declarerId, declarerDeclarationCount.get(declarerId)! + 1);
              }
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken;
      console.log(`Processed batch, found ${declarerIsccMap.size} declarers so far`);
    } while (continuationToken);

    // Build the response object
    const declarerStats: DeclarerIsccStats[] = [];
    const allUniqueIsccCodes = new Set<string>();
    let totalDeclarations = 0;

    for (const [declarerId, isccSet] of declarerIsccMap) {
      // Convert Set to sorted array for consistent ordering
      const isccCodes = Array.from(isccSet).sort();
      const totalDeclarationsForDeclarer = declarerDeclarationCount.get(declarerId) || 0;

      declarerStats.push({
        declarerId,
        uniqueIsccCount: isccSet.size,
        totalDeclarations: totalDeclarationsForDeclarer,
        // isccCodes
      });

      // Add all ISCC codes to the global set for total count
      for (const isccCode of isccSet) {
        allUniqueIsccCodes.add(isccCode);
      }

      // Add to total declarations count
      totalDeclarations += totalDeclarationsForDeclarer;
    }

    // Sort by declarerId for consistent ordering
    declarerStats.sort((a, b) => a.declarerId.localeCompare(b.declarerId));

    const result: UniqueIsccByDeclarerResponse = {
      declarerStats,
      totalUniqueIscc: allUniqueIsccCodes.size,
      totalDeclarations,
    };

    console.log(
      `Found ${declarerStats.length} declarers with total ${result.totalUniqueIscc} unique ISCC codes and ${result.totalDeclarations} total declarations`,
    );

    return result;
  } catch (error) {
    console.error("Error counting unique ISCC codes by declarer:", error);
    throw error;
  }
}

export async function countTotalValidDeclarationsInBucket(): Promise<number> {
  try {
    const s3 = createS3Client();
    const bucketName = Bucket.declarationData.bucketName;
    console.log(`Counting total valid declarations in bucket: ${bucketName}`);

    let totalDeclarations = 0;

    // List all objects in the bucket
    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
        MaxKeys: 1000, // Process in batches of 1000
      });

      const response = await s3.send(listCommand);

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            // Parse the S3 key structure: declarerId/ISCC_CODE/file.json
            const pathParts = object.Key.split("/");

            // We need at least 3 parts: declarerId, ISCC_CODE, filename
            if (pathParts.length >= 3) {
              const declarerId = pathParts[0];
              const isccCode = pathParts[1];
              const fileName = pathParts[2];

              // Only count valid declaration files
              if (declarerId && isccCode && isccCode.startsWith("ISCC:") && fileName.endsWith(".json")) {
                totalDeclarations++;
              }
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken;
      console.log(`Processed batch, found ${totalDeclarations} declarations so far`);
    } while (continuationToken);

    console.log(`Total valid declarations found: ${totalDeclarations}`);

    return totalDeclarations;
  } catch (error) {
    console.error("Error counting total valid declarations in bucket:", error);
    throw error;
  }
}

export async function getAllDeclarersInBucket(): Promise<string[]> {
  try {
    const s3 = createS3Client();
    const bucketName = Bucket.declarationData.bucketName;
    console.log(`Getting all declarers (first-level folders) in bucket: ${bucketName}`);

    // Set to store unique declarer IDs
    const uniqueDeclarers = new Set<string>();

    // Use delimiter to get only first-level "folders" efficiently
    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Delimiter: "/", // This will group objects by first-level "folders"
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await s3.send(listCommand);

      // CommonPrefixes contains the first-level "folder" names
      if (response.CommonPrefixes) {
        for (const prefix of response.CommonPrefixes) {
          if (prefix.Prefix) {
            // Remove trailing slash to get clean declarer ID
            const declarerId = prefix.Prefix.replace(/\/$/, "");

            // Only add valid declarer IDs (skip empty paths)
            if (declarerId && declarerId.trim() !== "") {
              uniqueDeclarers.add(declarerId);
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken;
      console.log(`Processed batch, found ${uniqueDeclarers.size} unique declarers so far`);
    } while (continuationToken);

    const declarersList = Array.from(uniqueDeclarers);
    console.log(`Total unique declarers found: ${declarersList.length}`);
    console.log(`Declarers: ${declarersList.join(", ")}`);

    return declarersList;
  } catch (error) {
    console.error("Error getting declarers from bucket:", error);
    throw error;
  }
}
