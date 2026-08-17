import axios, { AxiosResponse } from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getIsccServiceUrlByConfig } from "../searchUtils/isccServiceSelector";

interface Unit {
  readable: string;
  hash_hex: string;
  iscc_unit: string;
  hash_bits: string;
  hash_uint: string;
}

interface ExplainedISCC {
  iscc: string;
  readable: string;
  multiformat: string;
  decomposed: string;
  units: Unit[];
}

// The iscc-web service base URL is configured per stage via the ISCC_HOST
// parameter (see stacks/CommonsDBStack.ts). Both the create and explain calls
// derive from it so there are no environment-specific endpoints in source.
const isccCreateUrl = () => `${getIsccServiceUrlByConfig()}/api/v1/create`;
const isccExplainUrl = () => `${getIsccServiceUrlByConfig()}/api/v1/explain/`;

/**
 * Guard the user-supplied source URL before fetching it. Only http(s) is
 * allowed, and obvious internal / metadata targets are rejected to reduce the
 * SSRF surface of the generate-from-URL endpoint.
 */
function assertFetchableUrl(sourceUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Invalid source URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Unsupported URL scheme");
  }
  const host = parsed.hostname.toLowerCase();
  const blockedHosts = ["localhost", "metadata.google.internal"];
  const blockedPrefixes = ["127.", "10.", "192.168.", "169.254.", "0."];
  if (blockedHosts.includes(host) || host.endsWith(".localhost") || blockedPrefixes.some((p) => host.startsWith(p))) {
    throw new Error("URL host is not allowed");
  }
  return parsed;
}

async function downloadFile(sourceUrl: string): Promise<string> {
  assertFetchableUrl(sourceUrl);
  console.log(`Starting download from URL: ${sourceUrl}`);
  const response: AxiosResponse = await axios.get(sourceUrl, { responseType: "stream", maxRedirects: 0 });
  const tempDir = os.tmpdir();
  const filename = path.basename(sourceUrl);
  const filePath = path.join(tempDir, filename);

  console.log(`Saving file to: ${filePath}`);
  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      console.log(`File downloaded and saved to: ${filePath}`);
      resolve(filePath);
    });
    writer.on("error", (error) => {
      console.error(`Error downloading file: ${error}`);
      reject(error);
    });
  });
}

function deleteFile(filePath: string): void {
  console.log(`Deleting file: ${filePath}`);
  fs.unlinkSync(filePath);
}

async function createISCC(binaryData: Buffer, filename: string): Promise<any> {
  const startTime = Date.now();
  console.log(`Starting ISCC creation for file: ${filename}`);

  const response: AxiosResponse = await axios.post(isccCreateUrl(), binaryData, {
    headers: {
      accept: "application/json",
      "Content-Type": "application/octet-stream",
      "X-Upload-Filename": getBase64EncodedFilename(filename),
    },
  });

  if (response.status === 201) {
    const iscc = response.data;
    console.log(`ISCC created: ${iscc.iscc} Duration: ${Date.now() - startTime} ms`);
    return iscc;
  } else {
    console.error(`Error creating ISCC: ${response.status}: ${response.statusText}`);
    throw new Error(`createISCC: ${response.status}: ${response.statusText}`);
  }
}

function getBase64EncodedFilename(filename: string): string {
  return Buffer.from(filename).toString("base64");
}

export async function createISCCFromUrl(sourceUrl: string): Promise<any[]> {
  console.log(`Creating ISCC from URL: ${sourceUrl}`);
  let iscc = null;
  let filePath = "";

  try {
    filePath = await downloadFile(sourceUrl);
    const fileData = fs.readFileSync(filePath);
    iscc = await createISCC(fileData, path.basename(filePath));
    deleteFile(filePath);
  } catch (error) {
    console.error(`Error in createISCCFromUrl: ${error}`);
  }

  const response: any[] = [];

  if (iscc !== null) {
    const isccMetadata = { isccMetadata: iscc };
    response.push(isccMetadata);
  }

  console.log(`ISCC creation from URL completed. Response: ${JSON.stringify(response)}`);
  return response;
}

export async function explainISCC(iscc: string): Promise<ExplainedISCC> {
  const startTime = Date.now();
  console.log(`Explaining ISCC: ${iscc}`);

  const response: AxiosResponse = await axios.get(`${isccExplainUrl()}${iscc}`);

  if (response.status === 200) {
    const data = response.data;
    const units: Unit[] = data.units.map((unit: any) => ({
      readable: unit.readable,
      hash_hex: unit.hash_hex,
      iscc_unit: unit.iscc_unit,
      hash_bits: unit.hash_bits,
      hash_uint: unit.hash_uint,
    }));

    const explainedISCC: ExplainedISCC = {
      iscc: data.iscc,
      readable: data.readable,
      multiformat: data.multiformat,
      decomposed: data.decomposed,
      units,
    };

    console.log(`ISCC explained: ${explainedISCC.iscc} Duration: ${Date.now() - startTime} ms`);
    return explainedISCC;
  } else {
    console.error(`Error explaining ISCC: ${response.status}: ${response.statusText}`);
    throw new Error(`explainISCC: ${response.status}: ${response.statusText}`);
  }
}
