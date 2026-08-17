import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { serializeJson, hashSerializedJson, generateCidFromJson, createCidV1 } from "./cidUtil";
import { IDeclarationPublicMetadata } from "../interfaces/commonInterfaces";

describe("serializeJson", () => {
  it("is deterministic for identical input", () => {
    const obj = { b: 2, a: 1 };
    expect(serializeJson(obj).equals(serializeJson(obj))).toBe(true);
  });

  it("is independent of key insertion order (flat objects)", () => {
    const a = serializeJson({ a: 1, b: 2, c: 3 });
    const b = serializeJson({ c: 3, b: 2, a: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("produces keys in sorted order", () => {
    expect(serializeJson({ z: 1, a: 2 }).toString("utf-8")).toBe('{"a":2,"z":1}');
  });
});

describe("hashSerializedJson", () => {
  it("matches a plain SHA-256 digest of the input", () => {
    const input = Buffer.from("hello world", "utf-8");
    const expected = createHash("sha256").update(input).digest();
    expect(hashSerializedJson(input).equals(expected)).toBe(true);
  });

  it("returns a 32-byte digest for sha2-256", () => {
    expect(hashSerializedJson(Buffer.from("x")).length).toBe(32);
  });
});

describe("createCidV1", () => {
  const hash = createHash("sha256").update("payload").digest();

  it("is deterministic", () => {
    expect(createCidV1(hash)).toBe(createCidV1(hash));
  });

  it("changes when the hash changes", () => {
    const other = createHash("sha256").update("payload2").digest();
    expect(createCidV1(hash)).not.toBe(createCidV1(other));
  });

  it("returns a non-empty base32 string", () => {
    const cid = createCidV1(hash);
    expect(cid.length).toBeGreaterThan(0);
    expect(cid).toMatch(/^[a-z2-7]+$/);
  });
});

describe("generateCidFromJson", () => {
  const meta = { iscc: "ISCC:ABC", name: "demo" } as unknown as IDeclarationPublicMetadata;

  it("is deterministic across key order", () => {
    const reordered = { name: "demo", iscc: "ISCC:ABC" } as unknown as IDeclarationPublicMetadata;
    expect(generateCidFromJson(meta)).toBe(generateCidFromJson(reordered));
  });

  it("differs for different content", () => {
    const other = { iscc: "ISCC:XYZ", name: "demo" } as unknown as IDeclarationPublicMetadata;
    expect(generateCidFromJson(meta)).not.toBe(generateCidFromJson(other));
  });
});
