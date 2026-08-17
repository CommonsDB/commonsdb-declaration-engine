/**
 * API client for making test requests
 */

import axios, { AxiosResponse, AxiosError } from "axios";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";
import { TestConfig, getPublicKeyJwk } from "./testConfig";

// ============================================================================
// Types
// ============================================================================

export interface TsaSignature {
  tsr: string;
  tsq: string;
}

export interface DeclarationPayload {
  declarationMetadata: {
    publicMetadata: Record<string, any>;
    commonsDbRegistry?: Record<string, any>;
  };
  signature: string;
  tsaSignature: TsaSignature;
  commonsDbRegistrySignature?: string;
  commonsDbRegistryTsaSignature?: TsaSignature;
}

export interface ApiResponse<T = any> {
  success: boolean;
  statusCode?: number;
  data?: T;
  error?: string;
  errorData?: any;
  headers?: Record<string, string>;
}

export interface DeclarationStatusResponse {
  identifier: string;
  status: "pending" | "processing" | "completed" | "success" | "failed";
  message?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SearchResult {
  results: any[];
  total?: number;
  page?: number;
  limit?: number;
}

// ============================================================================
// JWT Signature
// ============================================================================

export function createJwtSignature(payload: any, privateKey: string, publicKeyPem: string): string {
  const jwk = getPublicKeyJwk(publicKeyPem);
  const header = {
    jwk: jwk,
    alg: "ES256",
    typ: "JWT",
  };
  return jwt.sign(payload, privateKey, {
    algorithm: "ES256",
    header: header,
  });
}

// ============================================================================
// TSA Timestamp
// ============================================================================

// Simple semaphore for TSA rate limiting
class TsaSemaphore {
  private available: number;
  private waitQueue: Array<() => void> = [];

  constructor(private max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

const tsaSemaphore = new TsaSemaphore(3);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getTimestamp(data: string, tsaUrl: string): Promise<TsaSignature> {
  const hash = crypto.createHash("sha512").update(data).digest();

  const hashAlgorithmOid = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03]);
  const algorithmIdentifier = Buffer.concat([Buffer.from([0x30, hashAlgorithmOid.length]), hashAlgorithmOid]);

  const hashedMessage = Buffer.concat([Buffer.from([0x04, hash.length]), hash]);

  const messageImprint = Buffer.concat([
    Buffer.from([0x30, algorithmIdentifier.length + hashedMessage.length]),
    algorithmIdentifier,
    hashedMessage,
  ]);

  const version = Buffer.from([0x02, 0x01, 0x01]);
  const tsReqContent = Buffer.concat([version, messageImprint]);
  const tsReq = Buffer.concat([Buffer.from([0x30, tsReqContent.length]), tsReqContent]);

  const tsqBase64 = tsReq.toString("base64");

  await tsaSemaphore.acquire();

  const maxRetries = 3;
  let lastError: Error | null = null;

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(tsaUrl, tsReq, {
          headers: { "Content-Type": "application/timestamp-query" },
          responseType: "arraybuffer",
          timeout: 30000,
        });

        if (!response.data || response.data.length === 0) {
          throw new Error("Empty TSA response");
        }

        const tsrBase64 = Buffer.from(response.data).toString("base64");
        return { tsr: tsrBase64, tsq: tsqBase64 };
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 500;
          await sleepMs(delay);
        }
      }
    }
    throw lastError || new Error("TSA request failed after retries");
  } finally {
    tsaSemaphore.release();
  }
}

// ============================================================================
// API Client
// ============================================================================

export class ApiClient {
  constructor(private config: TestConfig) {}

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  async submitDeclaration(payload: any): Promise<ApiResponse> {
    try {
      const response = await axios.post(`${this.config.apiBaseUrl}/v1/declare`, payload, {
        headers: this.getHeaders(),
        timeout: 60000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
        headers: response.headers as Record<string, string>,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
          headers: error.response.headers as Record<string, string>,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getDeclarationStatus(identifier: string): Promise<ApiResponse<DeclarationStatusResponse>> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/status/${encodeURIComponent(identifier)}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async search(query: string, options: { page?: number; limit?: number } = {}): Promise<ApiResponse<SearchResult>> {
    try {
      const params = new URLSearchParams();
      params.set("q", query);
      if (options.page) params.set("page", options.page.toString());
      if (options.limit) params.set("limit", options.limit.toString());

      const response = await axios.get(`${this.config.apiBaseUrl}/v1/search?${params.toString()}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async searchByIscc(iscc: string): Promise<ApiResponse> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/search/iscc/${encodeURIComponent(iscc)}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getMetadataByIdentifier(identifier: string): Promise<ApiResponse> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/metadata/${encodeURIComponent(identifier)}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getMetadataByCid(cid: string): Promise<ApiResponse> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/cid/${encodeURIComponent(cid)}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getLatest(limit: number = 10): Promise<ApiResponse> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/latest?limit=${limit}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getRandom(limit: number = 10): Promise<ApiResponse> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/v1/random?limit=${limit}`, {
        headers: this.getHeaders(),
        timeout: 30000,
      });
      return {
        success: true,
        statusCode: response.status,
        data: response.data,
      };
    } catch (error: any) {
      if (error.response) {
        return {
          success: false,
          statusCode: error.response.status,
          error: error.response.statusText,
          errorData: error.response.data,
        };
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
