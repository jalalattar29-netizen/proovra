/**
 * Phase A2 — Canonical Workspace AI policy evaluator.
 *
 * SINGLE source of truth for "may this AI/provider operation run for this
 * workspace?". Every active AI route MUST call `evaluateWorkspaceAiPolicy`
 * (or the pure `decideAiPolicy`) before any provider call — the logic is
 * NOT duplicated in individual routes.
 *
 * Design:
 *   - `decideAiPolicy(...)` is a PURE function (no DB, no env, no I/O) that
 *     implements the ordered gate. It is fully behaviourally testable.
 *   - `evaluateWorkspaceAiPolicy(...)` is the async wrapper that resolves the
 *     global flag, provider configuration, and the per-Team policy row, then
 *     calls `decideAiPolicy`.
 *
 * Safe default: a Team with NO `workspace_ai_policies` row resolves to
 * DEFAULT_WORKSPACE_AI_POLICY, which mirrors pre-A2 runtime behaviour
 * (advisory AI allowed subject to global flag + plan; content/raw/copilots
 * off). The A2 migration therefore changes nothing until an admin saves a
 * policy. `aiEnabled = false` is a fail-closed backend gate.
 *
 * Steps 9 (durable budget) and 10 (rate limit) are intentionally left as
 * downstream concerns wired in A7/A8; this evaluator owns steps 1–8.
 */
import { prisma } from "../../db.js";
import { getSecret } from "../../config/runtime-secrets.js";

export type WorkspaceAiFeature =
  | "SUPPORT_CHAT"
  | "CAPTURE_ASSISTANCE"
  | "EVIDENCE_CATEGORIZATION"
  | "SEMANTIC_SEARCH"
  | "CONTENT_INTELLIGENCE"
  | "REVIEWER_COPILOT"
  | "CASE_COPILOT";

/** Data sensitivity class of the payload the operation would send outbound. */
export type WorkspaceAiDataClass = "METADATA" | "DERIVED_CONTENT" | "RAW_CONTENT";

/** Bounded, machine-readable decision codes (never leak provider internals). */
export type WorkspaceAiDecision =
  | "ALLOWED"
  | "GLOBAL_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "WORKSPACE_DISABLED"
  | "FEATURE_DISABLED"
  | "ROLE_NOT_PERMITTED"
  | "PLAN_NOT_ENTITLED"
  | "DATA_CLASS_NOT_ALLOWED";

/** The resolved, effective policy for a workspace (row or safe default). */
export type ResolvedWorkspaceAiPolicy = {
  aiEnabled: boolean;
  supportChatEnabled: boolean;
  captureAssistanceEnabled: boolean;
  evidenceCategorizationEnabled: boolean;
  semanticSearchEnabled: boolean;
  contentIntelligenceEnabled: boolean;
  reviewerCopilotEnabled: boolean;
  caseCopilotEnabled: boolean;
  rawContentProcessingAllowed: boolean;
  ocrAllowed: boolean;
  transcriptionAllowed: boolean;
  embeddingsAllowed: boolean;
  allowedRoles: readonly string[] | null;
  policyVersion: number;
  /** true when this came from a persisted row, false when it is the default. */
  fromRow: boolean;
};

/**
 * Safe default that mirrors pre-A2 runtime behaviour. Advisory features on
 * (they were callable before, subject to the global flag + plan); anything
 * that sends derived/raw content, and the not-yet-built copilots, off.
 */
export const DEFAULT_WORKSPACE_AI_POLICY: ResolvedWorkspaceAiPolicy = {
  aiEnabled: true,
  supportChatEnabled: true,
  captureAssistanceEnabled: true,
  evidenceCategorizationEnabled: true,
  semanticSearchEnabled: false,
  contentIntelligenceEnabled: false,
  reviewerCopilotEnabled: false,
  caseCopilotEnabled: false,
  rawContentProcessingAllowed: false,
  ocrAllowed: false,
  transcriptionAllowed: false,
  embeddingsAllowed: false,
  allowedRoles: null,
  policyVersion: 1,
  fromRow: false,
};

const FEATURE_SWITCH: Record<
  WorkspaceAiFeature,
  keyof ResolvedWorkspaceAiPolicy
> = {
  SUPPORT_CHAT: "supportChatEnabled",
  CAPTURE_ASSISTANCE: "captureAssistanceEnabled",
  EVIDENCE_CATEGORIZATION: "evidenceCategorizationEnabled",
  SEMANTIC_SEARCH: "semanticSearchEnabled",
  CONTENT_INTELLIGENCE: "contentIntelligenceEnabled",
  REVIEWER_COPILOT: "reviewerCopilotEnabled",
  CASE_COPILOT: "caseCopilotEnabled",
};

export type AiPolicyDecisionInput = {
  policy: ResolvedWorkspaceAiPolicy;
  feature: WorkspaceAiFeature;
  /** Defaults to METADATA — the safest class. */
  dataClass?: WorkspaceAiDataClass;
  /** Actor's workspace role, if role-gating is configured. */
  userRole?: string | null;
  /** Whether platform AI is globally enabled (step 1). */
  globalAiEnabled: boolean;
  /** Whether the relevant provider is configured (step 2). */
  providerConfigured: boolean;
  /**
   * Whether the plan entitles this operation (step 6). Callers pass the
   * result of the existing durable plan check so it is not duplicated here;
   * undefined means "not evaluated / entitled".
   */
  planAllowed?: boolean;
};

export type AiPolicyDecision = {
  allowed: boolean;
  decision: WorkspaceAiDecision;
  reason: string;
  policyVersion: number;
};

/**
 * PURE ordered gate. No DB, no env — every input is supplied by the caller,
 * so this is fully behaviourally testable without mocks.
 */
export function decideAiPolicy(input: AiPolicyDecisionInput): AiPolicyDecision {
  const { policy } = input;
  const dataClass = input.dataClass ?? "METADATA";
  const base = { policyVersion: policy.policyVersion };

  // 1. Global platform AI state.
  if (!input.globalAiEnabled) {
    return {
      ...base,
      allowed: false,
      decision: "GLOBAL_DISABLED",
      reason: "AI is disabled at the platform level.",
    };
  }
  // 2. Provider configuration.
  if (!input.providerConfigured) {
    return {
      ...base,
      allowed: false,
      decision: "PROVIDER_NOT_CONFIGURED",
      reason: "The AI provider is not configured for this deployment.",
    };
  }
  // 3. Workspace master switch (fail-closed).
  if (!policy.aiEnabled) {
    return {
      ...base,
      allowed: false,
      decision: "WORKSPACE_DISABLED",
      reason: "AI is turned off for this workspace by policy.",
    };
  }
  // 4. Feature-specific switch.
  const featureField = FEATURE_SWITCH[input.feature];
  if (policy[featureField] !== true) {
    return {
      ...base,
      allowed: false,
      decision: "FEATURE_DISABLED",
      reason: `The ${input.feature} AI feature is turned off for this workspace.`,
    };
  }
  // 5. Role authorization (null allowlist = all roles permitted).
  if (policy.allowedRoles && policy.allowedRoles.length > 0) {
    const role = input.userRole ?? null;
    if (role === null || !policy.allowedRoles.includes(role)) {
      return {
        ...base,
        allowed: false,
        decision: "ROLE_NOT_PERMITTED",
        reason: "Your role is not permitted to use AI in this workspace.",
      };
    }
  }
  // 6. Plan entitlement (delegated durable check result).
  if (input.planAllowed === false) {
    return {
      ...base,
      allowed: false,
      decision: "PLAN_NOT_ENTITLED",
      reason: "This workspace's plan does not include this AI operation.",
    };
  }
  // 7/8. Data-class permission (default-deny beyond metadata).
  if (dataClass === "RAW_CONTENT" && !policy.rawContentProcessingAllowed) {
    return {
      ...base,
      allowed: false,
      decision: "DATA_CLASS_NOT_ALLOWED",
      reason: "Raw-content processing is not enabled for this workspace.",
    };
  }
  if (dataClass === "DERIVED_CONTENT" && !policy.contentIntelligenceEnabled) {
    return {
      ...base,
      allowed: false,
      decision: "DATA_CLASS_NOT_ALLOWED",
      reason: "Content intelligence is not enabled for this workspace.",
    };
  }

  return {
    ...base,
    allowed: true,
    decision: "ALLOWED",
    reason: "Permitted by workspace AI policy.",
  };
}

/** Coerce a persisted `allowed_roles_json` value into a bounded string list. */
function coerceAllowedRoles(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const roles = value.filter((v): v is string => typeof v === "string");
  return roles.length > 0 ? roles : null;
}

/** Resolve the effective policy for a Team (row or safe default). */
export async function resolveWorkspaceAiPolicy(
  teamId: string | null,
): Promise<ResolvedWorkspaceAiPolicy> {
  if (!teamId) return DEFAULT_WORKSPACE_AI_POLICY;
  const row = await prisma.workspaceAiPolicy.findUnique({ where: { teamId } });
  if (!row) return DEFAULT_WORKSPACE_AI_POLICY;
  return {
    aiEnabled: row.aiEnabled,
    supportChatEnabled: row.supportChatEnabled,
    captureAssistanceEnabled: row.captureAssistanceEnabled,
    evidenceCategorizationEnabled: row.evidenceCategorizationEnabled,
    semanticSearchEnabled: row.semanticSearchEnabled,
    contentIntelligenceEnabled: row.contentIntelligenceEnabled,
    reviewerCopilotEnabled: row.reviewerCopilotEnabled,
    caseCopilotEnabled: row.caseCopilotEnabled,
    rawContentProcessingAllowed: row.rawContentProcessingAllowed,
    ocrAllowed: row.ocrAllowed,
    transcriptionAllowed: row.transcriptionAllowed,
    embeddingsAllowed: row.embeddingsAllowed,
    allowedRoles: coerceAllowedRoles(row.allowedRolesJson),
    policyVersion: row.policyVersion,
    fromRow: true,
  };
}

/** True when the platform-level OpenAI advisory provider is usable. */
/**
 * Does this denial mean the OPERATOR cannot, or that the CUSTOMER will not?
 *
 * Two decisions describe the platform's own configuration: AI is switched off
 * globally, or no provider key is present. Every other decision describes this
 * workspace — its own opt-out, its plan, its roles, its data-class rule.
 *
 * The distinction decides whether a caller may still be served an answer that
 * needs no provider. Product documentation compiled into the build sends
 * nothing outbound, so an unconfigured operator is no reason to withhold it;
 * a workspace that turned the assistant off is every reason, and that opt-out
 * is honoured with no partial exceptions.
 *
 * It is a named predicate rather than a condition inline at each call site so
 * that the rule can be TESTED. Two call sites — the chat route and the
 * availability endpoint — must agree about it, and a rule spelled out twice is
 * a rule that will eventually be spelled out two different ways.
 */
export function isOperatorCapabilityGap(decision: WorkspaceAiDecision): boolean {
  return decision === "GLOBAL_DISABLED" || decision === "PROVIDER_NOT_CONFIGURED";
}

export function isOpenAiAdvisoryConfigured(): boolean {
  return Boolean(getSecret("OPENAI_API_KEY")?.trim());
}

/** True when platform AI is globally enabled (advisory family). */
export function isPlatformAiGloballyEnabled(): boolean {
  return process.env.OPENAI_AI_ENABLED === "true" && isOpenAiAdvisoryConfigured();
}

// ---------------------------------------------------------------------------
// Phase A2 — Policy CRUD (admin-managed). Optimistic-concurrency by version.
// ---------------------------------------------------------------------------

export type WorkspaceAiPolicyPatch = Partial<{
  aiEnabled: boolean;
  supportChatEnabled: boolean;
  captureAssistanceEnabled: boolean;
  evidenceCategorizationEnabled: boolean;
  semanticSearchEnabled: boolean;
  contentIntelligenceEnabled: boolean;
  reviewerCopilotEnabled: boolean;
  caseCopilotEnabled: boolean;
  rawContentProcessingAllowed: boolean;
  ocrAllowed: boolean;
  transcriptionAllowed: boolean;
  embeddingsAllowed: boolean;
  allowedRoles: string[] | null;
  dailyOperationLimit: number | null;
  monthlyOperationLimit: number | null;
  dailyCostLimitUsdMicros: bigint | null;
  monthlyCostLimitUsdMicros: bigint | null;
  retentionDays: number | null;
}>;

/**
 * Raised when a concurrent update changed the row since the client read it.
 *
 * PHASE 12B B1 — the wire code is the stable, cross-surface
 * `POLICY_VERSION_CONFLICT`. It replaces `AI_POLICY_VERSION_CONFLICT`, which
 * had no consumer anywhere in the tree (verified: no client, test, or e2e
 * reference), so this is a rename with no migration surface.
 */
export class WorkspaceAiPolicyVersionConflictError extends Error {
  readonly code = "POLICY_VERSION_CONFLICT";
  constructor(readonly currentVersion: number) {
    super("Workspace AI policy was modified by another change; reload and retry.");
    this.name = "WorkspaceAiPolicyVersionConflictError";
  }
}

/** Load the raw persisted row (or null when the workspace has no policy yet). */
export async function getWorkspaceAiPolicyRow(teamId: string) {
  return prisma.workspaceAiPolicy.findUnique({ where: { teamId } });
}

/** Translate the API patch into Prisma write columns (bounded). */
function patchToWriteData(patch: WorkspaceAiPolicyPatch) {
  const data: Record<string, unknown> = {};
  const bool = (k: keyof WorkspaceAiPolicyPatch) => {
    if (typeof patch[k] === "boolean") data[k] = patch[k];
  };
  bool("aiEnabled");
  bool("supportChatEnabled");
  bool("captureAssistanceEnabled");
  bool("evidenceCategorizationEnabled");
  bool("semanticSearchEnabled");
  bool("contentIntelligenceEnabled");
  bool("reviewerCopilotEnabled");
  bool("caseCopilotEnabled");
  bool("rawContentProcessingAllowed");
  bool("ocrAllowed");
  bool("transcriptionAllowed");
  bool("embeddingsAllowed");
  if (patch.allowedRoles !== undefined) {
    data.allowedRolesJson = patch.allowedRoles === null ? null : patch.allowedRoles;
  }
  if (patch.dailyOperationLimit !== undefined) data.dailyOperationLimit = patch.dailyOperationLimit;
  if (patch.monthlyOperationLimit !== undefined) data.monthlyOperationLimit = patch.monthlyOperationLimit;
  if (patch.dailyCostLimitUsdMicros !== undefined) data.dailyCostLimitUsdMicros = patch.dailyCostLimitUsdMicros;
  if (patch.monthlyCostLimitUsdMicros !== undefined) data.monthlyCostLimitUsdMicros = patch.monthlyCostLimitUsdMicros;
  if (patch.retentionDays !== undefined) data.retentionDays = patch.retentionDays;
  return data;
}

/** Prisma unique-constraint violation — the create-race loser. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Create or update a workspace AI policy.
 *
 * PHASE 12B B1 — ATOMIC OPTIMISTIC CONCURRENCY.
 *
 * The previous implementation was a read-compare-write: it loaded the row,
 * compared `policyVersion` in application memory, and then issued an
 * unconditional `update`. Two administrators saving concurrently BOTH passed
 * the comparison and BOTH wrote — last-write-wins, one change silently lost,
 * `policyVersion` bumped once per writer so the number no longer identified a
 * distinct state, and both callers received HTTP 200 plus a success audit
 * event describing a mutation that had already been overwritten.
 *
 * `expectedVersion` is now part of the DATABASE mutation predicate:
 *
 *   updateMany({ where: { teamId, policyVersion: expectedVersion }, … })
 *
 * so the row can only transition from exactly the version the client read.
 * The database — not this process — decides the winner:
 *
 *   * exactly ONE concurrent writer matches and mutates;
 *   * `policyVersion` increments exactly once per successful write;
 *   * every loser gets `count === 0` ⇒ throws
 *     WorkspaceAiPolicyVersionConflictError ⇒ the route returns a stable
 *     409 POLICY_VERSION_CONFLICT with ZERO mutation and NO success audit.
 *
 * Creation has the same property via the `teamId` unique constraint: the
 * create-race loser takes P2002 and is reported as a version conflict against
 * the row the winner just created — a deterministic first-writer path rather
 * than a crash or a silent second create attempt.
 *
 * SCOPE: `teamId` is the persisted workspace key. This function never accepts
 * an Organization/tenant subject from a caller-supplied field — the route
 * authorizes `teamId` first (`authorizeOrFail`), and the Organization is
 * whatever that workspace row is parented to in persistence.
 *
 * Returns { row, previous } so the caller can write a before/after audit.
 */
export async function upsertWorkspaceAiPolicy(input: {
  teamId: string;
  actorUserId: string;
  patch: WorkspaceAiPolicyPatch;
  expectedVersion?: number | null;
}) {
  const data = patchToWriteData(input.patch);
  const existing = await prisma.workspaceAiPolicy.findUnique({
    where: { teamId: input.teamId },
  });

  if (existing) {
    // The version the write is allowed to transition FROM. When the caller did
    // not declare one we still pin the predicate to the version we just read,
    // so an interleaved writer cannot be clobbered by a caller that simply
    // omitted `expectedVersion`.
    const fromVersion = input.expectedVersion ?? existing.policyVersion;
    if (input.expectedVersion != null && existing.policyVersion !== fromVersion) {
      // Already stale at read time — no need to attempt the write.
      throw new WorkspaceAiPolicyVersionConflictError(existing.policyVersion);
    }
    const { count } = await prisma.workspaceAiPolicy.updateMany({
      // ATOMIC PREDICATE — the version is part of the WHERE, so the row can
      // only move from `fromVersion`. A concurrent winner has already bumped
      // it and this predicate matches nothing.
      where: { teamId: input.teamId, policyVersion: fromVersion },
      data: {
        ...data,
        policyVersion: { increment: 1 },
        updatedByUserId: input.actorUserId,
      },
    });
    if (count === 0) {
      // ZERO MUTATION. Re-read only to report the version the client should
      // reconcile against; the read cannot resurrect the lost write.
      const current = await prisma.workspaceAiPolicy.findUnique({
        where: { teamId: input.teamId },
        select: { policyVersion: true },
      });
      throw new WorkspaceAiPolicyVersionConflictError(
        current?.policyVersion ?? fromVersion,
      );
    }
    const row = await prisma.workspaceAiPolicy.findUniqueOrThrow({
      where: { teamId: input.teamId },
    });
    return { row, previous: existing };
  }

  // No row yet. `expectedVersion` on a non-existent policy is itself a stale
  // read: the client believes it is editing a version that does not exist.
  if (input.expectedVersion != null) {
    throw new WorkspaceAiPolicyVersionConflictError(
      DEFAULT_WORKSPACE_AI_POLICY.policyVersion,
    );
  }
  try {
    const row = await prisma.workspaceAiPolicy.create({
      data: {
        teamId: input.teamId,
        ...data,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
      },
    });
    return { row, previous: null };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // DETERMINISTIC FIRST-WRITER CONFLICT — another creator won the race.
      const current = await prisma.workspaceAiPolicy.findUnique({
        where: { teamId: input.teamId },
        select: { policyVersion: true },
      });
      throw new WorkspaceAiPolicyVersionConflictError(
        current?.policyVersion ?? DEFAULT_WORKSPACE_AI_POLICY.policyVersion,
      );
    }
    throw err;
  }
}

export type EvaluateWorkspaceAiPolicyInput = {
  teamId: string | null;
  feature: WorkspaceAiFeature;
  dataClass?: WorkspaceAiDataClass;
  userRole?: string | null;
  planAllowed?: boolean;
};

/**
 * Canonical async entry point. Resolves global + provider + workspace policy,
 * then applies the pure ordered gate. Every active AI route calls this before
 * any provider call.
 */
/**
 * Feature-aware global/provider resolution. Different capabilities gate on
 * different platform flags/providers, so the evaluator must not apply the
 * advisory OpenAI flag to, e.g., semantic search.
 */
function resolveFeatureGlobalProvider(feature: WorkspaceAiFeature): {
  globalAiEnabled: boolean;
  providerConfigured: boolean;
} {
  const openai = isOpenAiAdvisoryConfigured();
  switch (feature) {
    case "SUPPORT_CHAT":
    case "CAPTURE_ASSISTANCE":
    case "EVIDENCE_CATEGORIZATION":
      return { globalAiEnabled: isPlatformAiGloballyEnabled(), providerConfigured: openai };
    case "SEMANTIC_SEARCH":
      return {
        globalAiEnabled: process.env.SEMANTIC_SEARCH_ENABLED === "true",
        providerConfigured: openai,
      };
    case "CONTENT_INTELLIGENCE":
    case "REVIEWER_COPILOT":
    case "CASE_COPILOT":
      // Platform availability for these is gated downstream (subprocessor keys /
      // copilot build state); here the evaluator's job is the workspace/feature/
      // role/data-class gate, so it does not impose the advisory OpenAI flag.
      return { globalAiEnabled: true, providerConfigured: true };
    default:
      return { globalAiEnabled: isPlatformAiGloballyEnabled(), providerConfigured: openai };
  }
}

export async function evaluateWorkspaceAiPolicy(
  input: EvaluateWorkspaceAiPolicyInput,
): Promise<AiPolicyDecision> {
  const policy = await resolveWorkspaceAiPolicy(input.teamId);
  const { globalAiEnabled, providerConfigured } = resolveFeatureGlobalProvider(
    input.feature,
  );
  return decideAiPolicy({
    policy,
    feature: input.feature,
    dataClass: input.dataClass,
    userRole: input.userRole,
    globalAiEnabled,
    providerConfigured,
    planAllowed: input.planAllowed,
  });
}
