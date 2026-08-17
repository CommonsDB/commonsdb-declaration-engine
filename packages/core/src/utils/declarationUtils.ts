import { IDeclarationPayload } from "../interfaces/commonInterfaces";

interface IRequestHeaders {
  "x-company-id"?: string;
  "x-declarer-id"?: string;
  "x-company-public-key"?: string;
}

interface IMetaInternalOptions {
  isccCode?: string;
  vectorId?: string;
  rayId?: string;
}

/**
 * Initializes or validates metaInternal data for a declaration payload
 * @param data The declaration payload
 * @param headers Request headers containing company and declarer information
 * @param options Additional options for metaInternal fields
 * @returns The processed declaration payload with initialized metaInternal
 * @throws Error if required headers are missing
 */
export function initializeMetaInternal(
  data: Partial<IDeclarationPayload>,
  headers: IRequestHeaders,
  options: IMetaInternalOptions = {},
): IDeclarationPayload {
  if (!data) {
    return {} as IDeclarationPayload;
  }
  // Extract values from headers
  const companyId = headers["x-company-id"];
  const declarerId = headers["x-declarer-id"];
  // Validate required headers
  //   if (!companyId) {
  //     throw new Error("Missing required header: x-company-id");
  //   }
  if (!declarerId) {
    throw new Error("Missing required header: x-declarer-id");
  }

  // Get ISCC code from either options or data
  const isccCode = options.isccCode || data.declarationMetadata?.publicMetadata?.iscc || "";

  // Initialize metaInternal if it doesn't exist
  if (!data.metaInternal) {
    data.metaInternal = {
      companyId: companyId || declarerId,
      declarerId,
      isccCode,
      vectorId: options.vectorId,
      rayId: options.rayId,
    };
  } else {
    // If metaInternal exists, ensure required fields are present
    data.metaInternal = {
      ...data.metaInternal,
      companyId: data.metaInternal.companyId || companyId || declarerId,
      declarerId: data.metaInternal.declarerId || declarerId,
      isccCode: data.metaInternal.isccCode || isccCode,
      vectorId: data.metaInternal.vectorId || options.vectorId,
      rayId: data.metaInternal.rayId || options.rayId,
    };
  }

  return data as IDeclarationPayload;
}
