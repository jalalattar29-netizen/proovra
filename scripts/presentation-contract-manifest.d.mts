/** Types for scripts/presentation-contract-manifest.mjs (B8-F-401 / B8-F-402). */
export declare const ROUTES_SRC: string;
export declare const MANIFEST_PATH: string;
export declare const RELEASE_CONTRACT_PATH: string;
export type PresentationContractConstants = { contractVersion: number; routeEpoch: number };
export type PresentationContractManifest = PresentationContractConstants & { routes: string[] };
export declare function extractApiRoutes(srcDir?: string): string[];
export declare function readContractConstants(file?: string): PresentationContractConstants;
export declare function readManifest(file?: string): PresentationContractManifest;
export declare function checkPresentationContract(input?: {
  routes?: string[];
  constants?: PresentationContractConstants;
  manifest?: PresentationContractManifest;
}): { ok: boolean; added: string[]; removed: string[]; problems: string[] };
