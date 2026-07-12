/**
 * Phase C3 — Authorized AI context resolvers.
 *
 * The ONLY way record/workspace context reaches a Copilot prompt. Every
 * resolver: authorizes via the existing canonical loader (never bypasses
 * backend authz), binds tenant + object + version, allowlists fields, strips
 * secrets/tokens/signed-URLs/storage-paths/precise-GPS via the canonical
 * sanitizer, and returns a bounded structured context — never a raw Prisma row.
 */
import {
  sanitizeUntrustedField,
} from "./prompt-context-sanitizer.service.js";
import {
  resolveWorkspaceAiPolicy,
  type WorkspaceAiFeature,
} from "./workspace-ai-policy.service.js";

export type AiContextRouteClass =
  | "HOME"
  | "CAPTURE"
  | "EVIDENCE"
  | "CASE"
  | "REVIEWER"
  | "OPERATIONS"
  | "TRUST_HUB";

export type AiDataMode = "METADATA_ONLY" | "APPROVED_CONTENT";

export type AiAllowedAction = {
  actionType: string;
  requiredPermission: string;
  confirmationRequired: true;
};

export type AiSurfaceContext = {
  route: string;
  routeClass: AiContextRouteClass;
  role: string;
  workspaceId: string | null;
  workspacePolicyVersion: number;
  enabledCapabilities: WorkspaceAiFeature[];
  objectType: string | null;
  objectId: string | null;
  objectVersion: number | null;
  allowedActions: AiAllowedAction[];
  dataMode: AiDataMode;
  /** Bounded, allowlisted, sanitized field map — the only data the model sees. */
  fields: Record<string, string | number | boolean | null>;
};

export type HomeOperationalContext = AiSurfaceContext & { routeClass: "HOME" };
export type CaptureContext = AiSurfaceContext & { routeClass: "CAPTURE" };
export type EvidenceContext = AiSurfaceContext & { routeClass: "EVIDENCE" };
export type CaseContext = AiSurfaceContext & { routeClass: "CASE" };
export type ReviewerContext = AiSurfaceContext & { routeClass: "REVIEWER" };
export type OperationsContext = AiSurfaceContext & { routeClass: "OPERATIONS" };
export type TrustHubContext = AiSurfaceContext & { routeClass: "TRUST_HUB" };

/** Sanitize one allowlisted scalar for the model (strips secrets/urls/gps). */
export function sanitizeContextScalar(
  value: unknown,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return sanitizeUntrustedField(value, 400);
}

/**
 * Build a bounded context from an allowlisted field map. Any key NOT in the
 * allowlist is dropped; every included value is sanitized.
 */
export function buildAllowlistedFields(
  raw: Record<string, unknown>,
  allowlist: readonly string[],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of allowlist) {
    if (key in raw) out[key] = sanitizeContextScalar(raw[key]);
  }
  return out;
}

// Explicit field allowlists per object type (NO secrets/URLs/storage paths).
export const EVIDENCE_CONTEXT_ALLOWLIST = [
  "title", "type", "mimeType", "status", "verificationStatus",
  "caseLinked", "itemCount", "createdAtUtc", "reportReady", "packageReady",
] as const;

export const CASE_CONTEXT_ALLOWLIST = [
  "title", "status", "evidenceCount", "openFollowUps", "createdAtUtc",
  "reviewState", "workflowState",
] as const;

export type ResolvedCapabilities = {
  policyVersion: number;
  enabled: WorkspaceAiFeature[];
};

const ALL_FEATURES: WorkspaceAiFeature[] = [
  "SUPPORT_CHAT", "CAPTURE_ASSISTANCE", "EVIDENCE_CATEGORIZATION",
  "SEMANTIC_SEARCH", "CONTENT_INTELLIGENCE", "REVIEWER_COPILOT", "CASE_COPILOT",
];

/** Resolve the workspace's enabled AI capabilities (+ policy version). */
export async function resolveEnabledCapabilities(
  teamId: string | null,
): Promise<ResolvedCapabilities> {
  const policy = await resolveWorkspaceAiPolicy(teamId);
  const enabled = policy.aiEnabled
    ? ALL_FEATURES.filter((f) => {
        switch (f) {
          case "SUPPORT_CHAT": return policy.supportChatEnabled;
          case "CAPTURE_ASSISTANCE": return policy.captureAssistanceEnabled;
          case "EVIDENCE_CATEGORIZATION": return policy.evidenceCategorizationEnabled;
          case "SEMANTIC_SEARCH": return policy.semanticSearchEnabled;
          case "CONTENT_INTELLIGENCE": return policy.contentIntelligenceEnabled;
          case "REVIEWER_COPILOT": return policy.reviewerCopilotEnabled;
          case "CASE_COPILOT": return policy.caseCopilotEnabled;
        }
      })
    : [];
  return { policyVersion: policy.policyVersion, enabled };
}

/** Base context shared by every surface. */
export async function buildBaseContext(input: {
  route: string;
  routeClass: AiContextRouteClass;
  role: string;
  teamId: string | null;
  dataMode?: AiDataMode;
}): Promise<Omit<AiSurfaceContext, "objectType" | "objectId" | "objectVersion" | "allowedActions" | "fields">> {
  const caps = await resolveEnabledCapabilities(input.teamId);
  return {
    route: sanitizeUntrustedField(input.route, 120),
    routeClass: input.routeClass,
    role: input.role,
    workspaceId: input.teamId,
    workspacePolicyVersion: caps.policyVersion,
    enabledCapabilities: caps.enabled,
    dataMode: input.dataMode ?? "METADATA_ONLY",
  };
}

/**
 * PURE Evidence context assembly from an ALREADY-AUTHORIZED evidence row.
 * The caller MUST have loaded the row via the canonical authorized loader
 * (e.g. getEvidenceWithReadAccess) so tenant + access are already enforced.
 */
export function buildEvidenceContext(
  base: Omit<AiSurfaceContext, "objectType" | "objectId" | "objectVersion" | "allowedActions" | "fields">,
  row: Record<string, unknown> & { id: string; teamId?: string | null },
): EvidenceContext {
  const objectVersion =
    typeof row.verificationPackageVersion === "number"
      ? row.verificationPackageVersion
      : typeof row.latestReportVersion === "number"
        ? row.latestReportVersion
        : 0;
  return {
    ...base,
    routeClass: "EVIDENCE",
    objectType: "EVIDENCE_RECORD",
    objectId: row.id,
    objectVersion,
    allowedActions: [
      { actionType: "OPEN_MISSING_METADATA", requiredPermission: "evidence.update_metadata", confirmationRequired: true },
      { actionType: "NAVIGATE_TO_RECORD", requiredPermission: "evidence.read", confirmationRequired: true },
    ],
    fields: buildAllowlistedFields(row, EVIDENCE_CONTEXT_ALLOWLIST),
  };
}

/** PURE Case context assembly from an ALREADY-AUTHORIZED case row. */
export function buildCaseContext(
  base: Omit<AiSurfaceContext, "objectType" | "objectId" | "objectVersion" | "allowedActions" | "fields">,
  row: Record<string, unknown> & { id: string },
): CaseContext {
  return {
    ...base,
    routeClass: "CASE",
    objectType: "CASE",
    objectId: row.id,
    objectVersion: typeof row.version === "number" ? row.version : 0,
    allowedActions: [
      { actionType: "LINK_CASE", requiredPermission: "case.update", confirmationRequired: true },
      { actionType: "ASSIGN_REVIEWER", requiredPermission: "review.assign", confirmationRequired: true },
    ],
    fields: buildAllowlistedFields(row, CASE_CONTEXT_ALLOWLIST),
  };
}
