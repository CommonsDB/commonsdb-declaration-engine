import { describe, it, expect } from "vitest";
import { initializeMetaInternal } from "./declarationUtils";
import { IDeclarationPayload } from "../interfaces/commonInterfaces";

const basePayload = () =>
  ({
    declarationMetadata: { publicMetadata: { iscc: "ISCC:FROM-METADATA" } },
  }) as unknown as Partial<IDeclarationPayload>;

describe("initializeMetaInternal", () => {
  it("throws when x-declarer-id is missing", () => {
    expect(() => initializeMetaInternal(basePayload(), {})).toThrow(/x-declarer-id/);
  });

  it("returns an empty payload when data is falsy", () => {
    expect(initializeMetaInternal(null as any, { "x-declarer-id": "did:key:z1" })).toEqual({});
  });

  it("initializes metaInternal from the declarer header", () => {
    const result = initializeMetaInternal(basePayload(), { "x-declarer-id": "did:key:z1" });
    expect(result.metaInternal.declarerId).toBe("did:key:z1");
  });

  it("falls back companyId to declarerId when x-company-id is absent", () => {
    const result = initializeMetaInternal(basePayload(), { "x-declarer-id": "did:key:z1" });
    expect(result.metaInternal.companyId).toBe("did:key:z1");
  });

  it("uses x-company-id when present", () => {
    const result = initializeMetaInternal(basePayload(), {
      "x-declarer-id": "did:key:z1",
      "x-company-id": "company-42",
    });
    expect(result.metaInternal.companyId).toBe("company-42");
  });

  it("takes the ISCC from options over publicMetadata", () => {
    const result = initializeMetaInternal(
      basePayload(),
      { "x-declarer-id": "did:key:z1" },
      { isccCode: "ISCC:FROM-OPTION" },
    );
    expect(result.metaInternal.isccCode).toBe("ISCC:FROM-OPTION");
  });

  it("falls back to the publicMetadata ISCC when no option is given", () => {
    const result = initializeMetaInternal(basePayload(), { "x-declarer-id": "did:key:z1" });
    expect(result.metaInternal.isccCode).toBe("ISCC:FROM-METADATA");
  });

  it("preserves existing metaInternal fields", () => {
    const payload = {
      ...basePayload(),
      metaInternal: { declarerId: "did:key:existing", companyId: "existing-co", isccCode: "ISCC:KEEP" },
    } as unknown as Partial<IDeclarationPayload>;
    const result = initializeMetaInternal(payload, { "x-declarer-id": "did:key:z1" });
    expect(result.metaInternal.declarerId).toBe("did:key:existing");
    expect(result.metaInternal.companyId).toBe("existing-co");
    expect(result.metaInternal.isccCode).toBe("ISCC:KEEP");
  });
});
