import { IdentifierFieldValuesType } from "../utils/fieldMapping";

export interface ICoreData {
  isccCode: string;
  cid: string;
  cidContentProvider: string;
  wellKnown: string;
  origin: string;
  metaUrl: string;
}

export type IDeclarationMetaInternal = {
  rayId?: string;
  isccCode: string;
  // Set once the vector is inserted via the search service; absent before indexing.
  vectorId?: string;
  companyId: string;
  declarerId: string;
  declarationId?: string; ///<---
  cid?: string;
  cidV1?: string;
} & { [key in IdentifierFieldValuesType]?: string };

export interface IDeclarationPayload {
  metaInternal: IDeclarationMetaInternal;
  signature: string; //contains signed ICoreData
  tsaSignature?: { tsr: string; tsq: string };
  commonsDbRegistrySignature?: string;
  commonsDbRegistryTsaSignature?: { tsr: string; tsq: string };
  optOutRegistrySignature?: string;
  optOutRegistryTsaSignature?: { tsr: string; tsq: string };
  faiaRegistrySignature?: string;
  faiaRegistryTsaSignature?: { tsr: string; tsq: string };
  declarationMetadata: {
    publicMetadata: IDeclarationPublicMetadata;
    optOutMetadata?: IDeclarationOptOutMetadata;
    faiaMetadata?: IDeclarationFaiaMetadata;
    commonsDbRegistry?: IDeclarationCommonsDbRegistry;
  };
}

export interface IDeclarationCommonsDbRegistry {
  iscc: string;
  declarationId?: string;
  location: string;
  signature: string;
  commonsDbRegistryTsaSignature: string;
  credentials: [
    {
      proof: string;
    },
  ];
  rightsStatement: string;
  timestamp: number;
}

export interface IDeclarationOptOutMetadata {
  cid?: string;
  declarationId?: string;
  iscc: string;
  credentials: [
    {
      proof: string;
    },
  ];
  usagePermission: string;
  timestamp: number;
}

export interface IDeclarationFaiaMetadata {
  iscc: string;
  timestamp: number;
  credentials: [
    {
      proof: string;
    },
  ];
  faiaPreferences: {
    faiaFlag: string;
    activityCode: string;
    systemAttributionSystem?: string;
    systemAttributionVersion?: string;
  };
}

export interface IDeclarationPublicMetadata {
  declarerId: string; ///<---
  "@context": string;
  $schema: string;
  original?: boolean;
  iscc?: string;
  name?: string;
  description?: string;
  mode?: string;
  filename?: string;
  filesize?: number;
  mediatype?: string;
  width?: number;
  height?: number;
  thumbnail?: string;
  metahash?: string;
  entryUUID?: string;
  datahash?: string;
  license?: string;
  acquire?: string;
  timestamp: number;
  redirect?: string;
  supersedes?: string; // CIDv1 identifier of a previous declaration this one supersedes
  version?: number; // Declaration version number
  // Legacy wire-format field carried by existing declarer payloads. The name is
  // preserved for backward compatibility with clients already sending it;
  // renaming it would be a breaking change to the declaration format.
  liccium_plugins?: {
    iptcMetadata?: {
      digitalsourcetype: string;
      keywords?: string;
      creator?: string;
      credit?: string;
      creditText?: string;
      copyrightNotice?: string;
      acquireLicensePage?: string;
      webstatementRights?: string;
    };
    tdmAiMetadata?: {
      TDMAI: boolean;
      TDMAI_policy_URL: string;
    };
    c2paMetadata?: {
      manifests: {
        [manifest_id: string]: {
          label: string;
          title: string;
          format: string;
          thumbnail: string;
          assertions: [];
          ingredients: [];
          instance_id: string;
          signature_info: {
            time: Date;
            issuer: string;
            timeObject: Date;
            cert_serial_number: string;
          };
          claim_generator: string;
        };
      };
      active_manifest: {
        label: string;
        title: string;
        format: string;
        thumbnail: string;
        assertions: [];
        ingredients: [];
        instance_id: string;
        signature_info: {
          time: Date;
          issuer: string;
          timeObject: Date;
          cert_serial_number: string;
        };
        claim_generator: string;
      };
      validation_status: [];
    };
  };

  credentials?: string; //url to credentials json with array of credentials
}
