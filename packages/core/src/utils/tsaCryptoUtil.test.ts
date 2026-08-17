import { describe, it, expect } from "vitest";
import { parseOID, parseTSQ, HASH_ALGORITHM_OIDS } from "./tsaCryptoUtil";

describe("parseOID", () => {
  it("decodes the SHA-256 algorithm OID", () => {
    // 2.16.840.1.101.3.4.2.1
    const bytes = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
    expect(parseOID(bytes)).toBe("2.16.840.1.101.3.4.2.1");
    expect(HASH_ALGORITHM_OIDS[parseOID(bytes)]).toBe("sha256");
  });

  it("decodes the SHA-1 algorithm OID", () => {
    // 1.3.14.3.2.26
    const bytes = new Uint8Array([0x2b, 0x0e, 0x03, 0x02, 0x1a]);
    expect(parseOID(bytes)).toBe("1.3.14.3.2.26");
  });

  it("handles multi-byte (base-128) arcs", () => {
    // 1.2.840.113549 (RSA) — 840 and 113549 span multiple bytes
    const bytes = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]);
    expect(parseOID(bytes)).toBe("1.2.840.113549");
  });
});

describe("parseTSQ", () => {
  // Deterministic RFC 3161 TimeStampQuery generated with:
  //   openssl ts -query -data <file> -sha256 -no_nonce
  // where sha256(<file>) = 171004f2293f4aab62e7d5bacb4ef8ea9dd572dc00fac4fd9f59a8fa7df22179
  const TSQ_B64 = "MDYCAQEwMTANBglghkgBZQMEAgEFAAQgFxAE8ik/Sqti59W6y0746p3VctwA+sT9n1mo+n3yIXk=";
  const EXPECTED_HASH = "171004f2293f4aab62e7d5bacb4ef8ea9dd572dc00fac4fd9f59a8fa7df22179";

  it("extracts the hash algorithm and message imprint", () => {
    const parsed = parseTSQ(TSQ_B64);
    expect(parsed).not.toBeNull();
    expect(parsed!.hashAlgorithm).toBe("sha256");
    expect(parsed!.hash.toString("hex")).toBe(EXPECTED_HASH);
  });

  it("returns null for non-ASN.1 input instead of throwing", () => {
    expect(parseTSQ("not-base64-asn1")).toBeNull();
  });
});
