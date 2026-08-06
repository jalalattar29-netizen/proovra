/** PHASE 12 — POINT 8: types for the Staging deployment guard. */
export interface StagingDeployRequest {
  ref: string;
  environment: string;
  imageTags: string[];
  secretRefs: Record<string, string>;
  wave: string;
  contractRehearsalApproved?: boolean;
  preflightPassed?: boolean;
  buildIds: { api: string; worker: string; web: string };
}
export interface GuardRefusal {
  rule: string;
  reason: string;
}
export interface GuardResult {
  ok: boolean;
  refusals: GuardRefusal[];
}
export declare const PRODUCTION_TRIGGER_BRANCHES: Set<string>;
export declare const PRODUCTION_ENVIRONMENTS: Set<string>;
export declare const MUTABLE_TAGS: Set<string>;
export declare const PRODUCTION_SECRET_NAMES: Set<string>;
export declare const DEFAULT_ALLOWED_WAVES: Set<string>;
export declare function validateStagingDeploy(request: Partial<StagingDeployRequest>): GuardResult;
export declare function validateStagingWorkflowSource(yamlText: string): GuardResult;
