/**
 * TSA (Time Stamp Authority) Cryptographic Utilities
 *
 * Low-level ASN.1 parsing functions for TSA requests and responses.
 * These functions handle the cryptographic parsing of TSQ (TimeStampQuery)
 * and TSR (TimeStampResponse) structures according to RFC 3161.
 */

import * as asn1js from "asn1js";

// OID mappings for hash algorithms
export const HASH_ALGORITHM_OIDS: { [key: string]: string } = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.4": "sha224",
};

export interface ParsedTSQ {
  hashAlgorithm: string;
  hash: Buffer;
}

export interface ParsedTSR {
  hashAlgorithm: string;
  hash: Buffer;
  timestamp: Date;
  serialNumber: string;
  status: number;
}

/**
 * Parses an ASN.1 OID and converts it to dotted string format
 */
export function parseOID(oidBuffer: Uint8Array): string {
  const oid: number[] = [];

  // First byte encodes first two components
  oid.push(Math.floor(oidBuffer[0] / 40));
  oid.push(oidBuffer[0] % 40);

  // Remaining bytes encode subsequent components (base-128)
  let value = 0;
  for (let i = 1; i < oidBuffer.length; i++) {
    value = (value << 7) | (oidBuffer[i] & 0x7f);
    if ((oidBuffer[i] & 0x80) === 0) {
      oid.push(value);
      value = 0;
    }
  }

  return oid.join(".");
}

/**
 * Extracts the MessageImprint (hash algorithm + hash) from a TimeStampQuery (TSQ)
 *
 * TimeStampReq ::= SEQUENCE {
 *   version         INTEGER { v1(1) },
 *   messageImprint  MessageImprint,
 *   ...
 * }
 *
 * MessageImprint ::= SEQUENCE {
 *   hashAlgorithm   AlgorithmIdentifier,
 *   hashedMessage   OCTET STRING
 * }
 */
export function parseTSQ(tsqBase64: string): ParsedTSQ | null {
  console.log("[TSA Verification] Parsing TimeStampQuery (TSQ)...");

  try {
    const tsqBuffer = Buffer.from(tsqBase64, "base64");
    const asn1 = asn1js.fromBER(tsqBuffer);

    if (asn1.offset === -1) {
      console.error("[TSA Verification] Failed to parse TSQ ASN.1 structure");
      return null;
    }

    const tsqSequence = asn1.result as asn1js.Sequence;
    if (tsqSequence.valueBlock.value.length < 2) {
      console.error("[TSA Verification] TSQ structure invalid - missing required fields");
      return null;
    }

    // Skip version (first element), get messageImprint (second element)
    const messageImprint = tsqSequence.valueBlock.value[1] as asn1js.Sequence;

    // MessageImprint contains: AlgorithmIdentifier, hashedMessage
    const algorithmIdentifier = messageImprint.valueBlock.value[0] as asn1js.Sequence;
    const hashedMessage = messageImprint.valueBlock.value[1] as asn1js.OctetString;

    // Get the OID from AlgorithmIdentifier
    const oidElement = algorithmIdentifier.valueBlock.value[0] as asn1js.ObjectIdentifier;
    const oidString = oidElement.valueBlock.toString();
    const hashAlgorithm = HASH_ALGORITHM_OIDS[oidString] || oidString;

    // Get the hash value
    const hashBuffer = Buffer.from(hashedMessage.valueBlock.valueHexView);

    console.log(`[TSA Verification] TSQ parsed - Algorithm: ${hashAlgorithm}, Hash length: ${hashBuffer.length} bytes`);

    return {
      hashAlgorithm,
      hash: hashBuffer,
    };
  } catch (error: any) {
    console.error("[TSA Verification] Error parsing TSQ:", error.message);
    return null;
  }
}

/**
 * Extracts the MessageImprint and timestamp from a TimeStampResponse (TSR)
 *
 * TimeStampResp ::= SEQUENCE {
 *   status          PKIStatusInfo,
 *   timeStampToken  TimeStampToken OPTIONAL
 * }
 *
 * TimeStampToken ::= ContentInfo (contains SignedData with TSTInfo)
 *
 * TSTInfo ::= SEQUENCE {
 *   version         INTEGER,
 *   policy          OBJECT IDENTIFIER,
 *   messageImprint  MessageImprint,
 *   serialNumber    INTEGER,
 *   genTime         GeneralizedTime,
 *   ...
 * }
 */
export function parseTSR(tsrBase64: string): ParsedTSR | null {
  console.log("[TSA Verification] Parsing TimeStampResponse (TSR)...");

  try {
    const tsrBuffer = Buffer.from(tsrBase64, "base64");
    const asn1 = asn1js.fromBER(tsrBuffer);

    if (asn1.offset === -1) {
      console.error("[TSA Verification] Failed to parse TSR ASN.1 structure");
      return null;
    }

    const tsrSequence = asn1.result as asn1js.Sequence;

    // First element is PKIStatusInfo
    const statusInfo = tsrSequence.valueBlock.value[0] as asn1js.Sequence;
    const statusInteger = statusInfo.valueBlock.value[0] as asn1js.Integer;
    const status = statusInteger.valueBlock.valueDec;

    console.log(`[TSA Verification] TSR Status: ${status} (0=granted, 1=grantedWithMods, 2=rejection)`);

    if (status > 1) {
      console.error("[TSA Verification] TSR indicates rejection or error status");
      return null;
    }

    // Second element is TimeStampToken (ContentInfo)
    if (tsrSequence.valueBlock.value.length < 2) {
      console.error("[TSA Verification] TSR missing TimeStampToken");
      return null;
    }

    const contentInfo = tsrSequence.valueBlock.value[1] as asn1js.Sequence;

    // ContentInfo contains contentType OID and content (SignedData)
    // content is context-tagged [0]
    const contentElement = contentInfo.valueBlock.value[1] as asn1js.Constructed;
    const signedData = contentElement.valueBlock.value[0] as asn1js.Sequence;

    // SignedData structure:
    // version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
    // We need encapContentInfo which contains TSTInfo
    const encapContentInfo = signedData.valueBlock.value[2] as asn1js.Sequence;

    // encapContentInfo contains: eContentType OID and eContent [0] OCTET STRING
    const eContentElement = encapContentInfo.valueBlock.value[1] as asn1js.Constructed;
    const eContentOctet = eContentElement.valueBlock.value[0] as asn1js.OctetString;

    // Parse the TSTInfo from eContent
    const tstInfoAsn1 = asn1js.fromBER(eContentOctet.valueBlock.valueHexView);
    const tstInfo = tstInfoAsn1.result as asn1js.Sequence;

    // TSTInfo fields: version, policy, messageImprint, serialNumber, genTime, ...
    // Index 2 is messageImprint
    const messageImprint = tstInfo.valueBlock.value[2] as asn1js.Sequence;
    const algorithmIdentifier = messageImprint.valueBlock.value[0] as asn1js.Sequence;
    const hashedMessage = messageImprint.valueBlock.value[1] as asn1js.OctetString;

    // Get hash algorithm
    const oidElement = algorithmIdentifier.valueBlock.value[0] as asn1js.ObjectIdentifier;
    const oidString = oidElement.valueBlock.toString();
    const hashAlgorithm = HASH_ALGORITHM_OIDS[oidString] || oidString;

    // Get hash
    const hashBuffer = Buffer.from(hashedMessage.valueBlock.valueHexView);

    // Index 3 is serialNumber
    const serialNumberInt = tstInfo.valueBlock.value[3] as asn1js.Integer;
    const serialNumber = Buffer.from(serialNumberInt.valueBlock.valueHexView).toString("hex");

    // Index 4 is genTime (GeneralizedTime)
    const genTime = tstInfo.valueBlock.value[4] as asn1js.GeneralizedTime;
    const timestamp = genTime.toDate();

    console.log(`[TSA Verification] TSR parsed successfully:`);
    console.log(`[TSA Verification]   - Algorithm: ${hashAlgorithm}`);
    console.log(`[TSA Verification]   - Hash length: ${hashBuffer.length} bytes`);
    console.log(`[TSA Verification]   - Timestamp: ${timestamp.toISOString()}`);
    console.log(`[TSA Verification]   - Serial Number: ${serialNumber}`);

    return {
      hashAlgorithm,
      hash: hashBuffer,
      timestamp,
      serialNumber,
      status,
    };
  } catch (error: any) {
    console.error("[TSA Verification] Error parsing TSR:", error.message);
    console.error("[TSA Verification] Error stack:", error.stack);
    return null;
  }
}
