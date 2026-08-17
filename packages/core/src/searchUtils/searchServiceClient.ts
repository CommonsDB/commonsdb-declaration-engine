import { Config } from "sst/node/config";
import axios from "axios";

// HTTP client for the external search service's QUERY endpoint (see
// docs/search-service-contract.md). The service owns everything below the
// ISCC level: content resolution, the similarity index, and its storage.
// Indexing does NOT go through HTTP — the ingest pipeline emits events to the
// service's Kinesis index stream instead (see searchIndexProducer.ts).

export interface ISearchServiceMatch {
  /** Opaque, stable id of an indexed declaration (the key stored in vectorToDataMap). */
  itemId: string;
  /** Similarity score: 0 = identical, higher = less similar. */
  score: number;
}

export interface ISearchServiceSearchResponse {
  /** Content representation of the queried ISCC, echoed by the service (exposed in API responses). */
  hashBits: string;
  results: ISearchServiceMatch[];
}

function makeHeaders() {
  return {
    "x-api-key": Config.SECRET_SEARCH_SERVICE_API_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * Similarity search by ISCC. Returns up to 100 nearest indexed items; callers
 * apply their own score cutoff.
 */
export const searchSimilarIscc = async (iscc: string): Promise<ISearchServiceSearchResponse> => {
  try {
    console.log("Search service: searching similar to ISCC:", iscc);
    const { data } = await axios.post(
      `${Config.SEARCH_SERVICE_URL}/api/v1/search`,
      { iscc },
      { headers: makeHeaders() },
    );
    console.log("Search service: search result:", data);
    return { hashBits: data.hashBits, results: data.results };
  } catch (error: any) {
    console.error("Search service search error:", error?.response?.data || error);
    throw error;
  }
};
