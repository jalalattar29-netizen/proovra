export declare const REAL: {
  boundFingerprintCanonicalJson: string;
  boundFingerprintHash: string;
  boundProofBase64: string;
  otherCanonicalJson: string;
  otherDigest: string;
  otherProofBase64: string;
};

export type UpgradedProof = {
  base64: string;
  bytes: Uint8Array;
  digestHex: string;
  blockHeight: number;
  txid: string | null;
  merkleRootHex: string | null;
  proofSha256: string;
};

export declare function txAround(leaf: Uint8Array): { prefix: Uint8Array; suffix: Uint8Array; tx: Uint8Array };
export declare function upgradedProof(o?: {
  base64?: string;
  blockHeight?: number;
  withTransaction?: boolean;
  merkleLevels?: number;
  trailingPayload?: Uint8Array;
  unexecutedOp?: number | null;
  keepCalendars?: boolean;
}): UpgradedProof;
export declare function proofSha256(base64: string): string;
export declare function truncated(base64?: string, n?: number): string;
export declare function badMagic(base64?: string): string;
export declare function tooDeep(depth?: number): string;
export declare function tooLarge(): string;
