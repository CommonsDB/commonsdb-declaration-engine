# CommonsDB Declaration Schema v0.2.0

## Overview

This schema defines the complete structure for CommonsDB declaration request payloads. It covers the entire declaration including signatures, timestamps, and metadata.

**Important**: The `schema` and `context` URLs are included in `publicMetadata`, but they define the validation rules for the **entire body structure**.

## Schema URLs

- **Schema**: `https://w3id.org/commonsdb/schema/0.2.0.json`
- **Context**: `https://w3id.org/commonsdb/context/0.2.0.json`

## Declaration Structure

The complete declaration request has the following top-level structure:

```json
{
  "signature": "<JWT signed over publicMetadata content>",
  "tsaSignature": {
    "tsr": "<base64 timestamp response>",
    "tsq": "<base64 timestamp query>"
  },
  "commonsDbRegistrySignature": "<JWT signed over commonsDbRegistry content>",
  "commonsDbRegistryTsaSignature": {
    "tsr": "<base64>",
    "tsq": "<base64>"
  },
  "declarationMetadata": {
    "publicMetadata": {
      "$schema": "https://w3id.org/commonsdb/schema/0.2.0.json",
      "@context": "https://w3id.org/commonsdb/context/0.2.0.json",
      ...other fields...
    },
    "commonsDbRegistry": { ... }
  }
}
```

### Signature Verification

- **`signature`**: JWT signature over `publicMetadata` content - verified against publicMetadata
- **`commonsDbRegistrySignature`**: JWT signature over `commonsDbRegistry` content - verified against commonsDbRegistry

## Required Fields

### Always Required
- `signature` - JWT signature over the declaration data
- `tsaSignature` - TSA timestamp for the main signature
  - `tsaSignature.tsr` - Timestamp Response (base64)
  - `tsaSignature.tsq` - Timestamp Query (base64)
- `declarationMetadata.publicMetadata` - Public declaration metadata

### Required When `commonsDbRegistry` is Provided
- `commonsDbRegistrySignature` - JWT signature for CommonsDB registry
- `commonsDbRegistryTsaSignature` - TSA timestamp for CommonsDB signature
  - `commonsDbRegistryTsaSignature.tsr`
  - `commonsDbRegistryTsaSignature.tsq`

## Validation Rules

### Timestamp Validation
- All timestamps must be within **60 seconds** of server time
- Timestamps are Unix timestamps in **milliseconds**

### TSA Signature Verification
TSA signatures are verified by **content only**:
1. Parse TSQ (Timestamp Query) to get the hash that was sent for timestamping
2. Parse TSR (Timestamp Response) to get the hash that was signed
3. Verify TSQ hash matches TSR hash
4. Verify the hash matches the original signature data

**Note**: TSA verification does NOT check timestamp expiration or age.

### Signature Format
All JWT signatures must match the pattern:
```
^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$
```

## Public Metadata Structure

Required fields in `declarationMetadata.publicMetadata`:
- `iscc` - ISCC code (pattern: `^ISCC:[A-Z0-9]{4,}$`)
- `name` - Title/name of the work
- `timestamp` - Unix timestamp in milliseconds
- `declarerId` - DID of the declarer
- `credentials` - Array of verifiable credentials

Optional fields:
- `description` - Description of the work
- `mediatype` - MIME type
- `thumbnail` - Base64 thumbnail or Data URI
- `sourceUrl` - URL to original content
- `version` - Version number
- `supplierMetadata` - Additional supplier metadata

## CommonsDB Registry Structure

Required fields in `declarationMetadata.commonsDbRegistry`:
- `iscc` - ISCC code
- `location` - URL where content can be accessed
- `rightsStatement` - Rights/license URL
- `timestamp` - Unix timestamp in milliseconds
- `credentials` - Array with at least one credential proof

Each credential in `commonsDbRegistry.credentials` must have:
- `proof` - JWT proof string

## Files in This Directory

| File | Description |
|------|-------------|
| `example.json` | Complete example declaration request |
| `README.md` | This documentation file |

The JSON Schema and JSON-LD context are **not shipped as files in this directory**. The
authoritative schema lives inline as `LOCAL_SCHEMA` in `packages/functions/src/ingest.ts` and is
applied by the custom `validateAgainstJsonSchema` validator.

## Allowed Rights Statements

The `rightsStatement` field must be one of the following valid values:

### Public Domain
- `https://creativecommons.org/publicdomain/mark/1.0/`
- `https://creativecommons.org/publicdomain/zero/1.0/`

### Creative Commons Licenses
All CC BY and CC BY-SA licenses from versions 1.0 to 4.0 are supported, including:
- **CC BY**: Attribution licenses (versions 1.0, 2.0, 2.1, 2.5, 3.0, 4.0)
- **CC BY-SA**: Attribution-ShareAlike licenses (versions 1.0, 2.0, 2.1, 2.5, 3.0, 4.0)

Including all country/jurisdiction-specific ports (e.g., `/de/`, `/fr/`, `/us/`, etc.)

See the `RightsStatement` definition in `LOCAL_SCHEMA` (`packages/functions/src/ingest.ts`) for
the complete list of 208 allowed values.

## Version History

### v0.2.0 (Current)
- Full declaration schema covering entire request payload
- Includes signature and TSA signature structures
- Timestamp validation: 60-second window from server time
- TSA verification: content-only (tsq/tsr hash match)
- Conditional requirement: `commonsDbRegistrySignature` and `commonsDbRegistryTsaSignature` required only when `commonsDbRegistry` is provided
- Added enum validation for `rightsStatement` with 208 allowed Creative Commons and Public Domain license URLs

### v0.1.0
- Initial schema for publicMetadata only
