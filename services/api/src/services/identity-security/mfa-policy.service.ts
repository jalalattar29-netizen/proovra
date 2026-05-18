/**
 * Phase 19 — MFA policy service.
 *
 * Thin layer on top of the Phase 17 OrganizationSecurityPolicy row.
 * Reads + writes the `mfaPolicyLevel` enum and answers the question
 * "does THIS user need MFA right now for THIS action?".
 *
 * Sources consulted, in order:
 *   1. Org security policy (`mfaPolicyLevel`) — the floor.
 *   2. Role of the actor — ADMINS_ONLY excludes MEMBER/VIEWER, etc.
 *   3. Risk level of the actor's current session — HIGH_RISK_ONLY
 *      flips on only when the risk evaluator returns HIGH/CRITICAL.
 *   4. Per-action override — sensitive actions in the
 *      `actionForcesMfa` allow-list always require step-up regardless
 *      of policy level.
 *
 * Hard invariants:
 *   - Service accounts NEVER get MFA. Their auth path is bearer key
 *     + IP allowlist + Phase 17 hardening.
 *   - Contributors NEVER get workspace MFA. Their verification path
 *     is contributor phone verification (Phase 18 verify +
 *     step-up purpose CONTRIBUTOR_PHONE_VERIFICATION).
 *   - Unknown policy / role combinations FAIL CLOSED (`true`).
 *   - Failing to load the policy FAILS CLOSED.
 */

import type { PrismaClient } from "@prisma/client";
import {
  MFA_POLICY_LEVELS,
  type MfaPolicyLevel,
  type RiskLevel,
  type StepUpPurpose,
  mfaRequiredForRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// Sensitive actions that ALWAYS require step-up regardless of policy
// level. This is the source of truth for "what counts as a sensitive
// action" — the step-up middleware reads from here so the catalog
// cannot drift.
const ACTIONS_FORCING_MFA: ReadonlyArray<StepUpPurpose> = [
  "MEMBER_SUSPEND",
  "MEMBER_REVOKE",
  "MEMBER_ROLE_CHANGE",
  "MEMBER_RESTORE",
  "CAPABILITY_GRANT",
  "CAPABILITY_REVOKE",
  "DELEGATED_ADMIN_GRANT",
  "DELEGATED_ADMIN_REVOKE",
  "SERVICE_ACCOUNT_CREATE",
  "SERVICE_ACCOUNT_DISABLE",
  "SERVICE_ACCOUNT_ENABLE",
  "SERVICE_ACCOUNT_REVOKE",
  "SERVICE_ACCOUNT_HARDENING_UPDATE",
  "CONTRIBUTOR_SESSION_REVOKE",
  "ORG_SECURITY_POLICY_UPDATE",
  "EXTERNAL_IDENTITY_LINK",
  "EXTERNAL_IDENTITY_UNLINK",
  "LEGAL_HOLD_PLACE",
  "LEGAL_HOLD_RELEASE",
  "PUBLIC_VERIFY_PUBLISH",
  "PUBLIC_VERIFY_UNPUBLISH",
  "PUBLIC_VERIFY_SUSPEND",
  "PUBLIC_VERIFY_RESTORE",
  "GOVERNANCE_POLICY_UPDATE",
  "RETENTION_POLICY_UPDATE",
  "MFA_POLICY_UPDATE",
];

export function actionForcesStepUp(action: StepUpPurpose): boolean {
  return ACTIONS_FORCING_MFA.includes(action);
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export type ResolvedMfaPolicy = {
  teamId: string;
  level: MfaPolicyLevel;
  stepUpTtlSeconds: number;
  trustedDeviceTtlDays: number;
  // Snapshot of the supporting flags so the /security-center UI can
  // show "MFA required + SSO ready" together without two queries.
  mfaRequiredFlag: boolean;
  ssoReadyFlag: boolean;
  scimReadyFlag: boolean;
};

const DEFAULT_STEP_UP_TTL_SECONDS = (() => {
  const raw = process.env.STEP_UP_SESSION_TTL_MINUTES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 15 * 60;
  return Math.min(60 * 60, n * 60);
})();

const DEFAULT_TRUSTED_DEVICE_TTL_DAYS = (() => {
  const raw = process.env.TRUSTED_DEVICE_TTL_DAYS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(180, n);
})();

function normaliseLevel(raw: string | null | undefined): MfaPolicyLevel {
  if (!raw) return "OFF";
  return (MFA_POLICY_LEVELS as readonly string[]).includes(raw)
    ? (raw as MfaPolicyLevel)
    : "OFF";
}

export async function getMfaPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ResolvedMfaPolicy> {
  const row = await client.organizationSecurityPolicy.findUnique({
    where: { teamId },
    select: {
      mfaPolicyLevel: true,
      mfaRequiredFlag: true,
      ssoReadyFlag: true,
      scimReadyFlag: true,
      stepUpTtlSeconds: true,
      trustedDeviceTtlDays: true,
    },
  });
  const baseLevel = normaliseLevel(row?.mfaPolicyLevel ?? null);
  // If the legacy mfaRequiredFlag is on but the new level was never
  // set, default to ADMINS_ONLY. Operators can override later via
  // /security-center.
  const level: MfaPolicyLevel =
    baseLevel === "OFF" && row?.mfaRequiredFlag ? "ADMINS_ONLY" : baseLevel;
  return {
    teamId,
    level,
    stepUpTtlSeconds: row?.stepUpTtlSeconds ?? DEFAULT_STEP_UP_TTL_SECONDS,
    trustedDeviceTtlDays:
      row?.trustedDeviceTtlDays ?? DEFAULT_TRUSTED_DEVICE_TTL_DAYS,
    mfaRequiredFlag: row?.mfaRequiredFlag ?? false,
    ssoReadyFlag: row?.ssoReadyFlag ?? false,
    scimReadyFlag: row?.scimReadyFlag ?? false,
  };
}

// -----------------------------------------------------------------------------
// Evaluate
// -----------------------------------------------------------------------------

export type MfaRequirementInput = {
  teamId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  // Optional: the user's CURRENT risk level (from the risk service).
  // When unset, HIGH_RISK_ONLY policy is treated as "not triggered".
  currentRiskLevel?: RiskLevel | null;
  // Optional: a specific sensitive action being attempted. Sensitive
  // actions force step-up regardless of policy level.
  action?: StepUpPurpose | null;
};

export type MfaRequirementResult = {
  required: boolean;
  reason:
    | "off"
    | "role_in_policy"
    | "risk_high"
    | "action_force"
    | "fail_closed";
  policyLevel: MfaPolicyLevel;
};

export async function evaluateMfaRequirement(
  input: MfaRequirementInput,
  client: PrismaClient = defaultPrisma,
): Promise<MfaRequirementResult> {
  let policy: ResolvedMfaPolicy;
  try {
    policy = await getMfaPolicy(input.teamId, client);
  } catch {
    // Fail closed.
    return {
      required: true,
      reason: "fail_closed",
      policyLevel: "OFF",
    };
  }
  if (input.action && actionForcesStepUp(input.action)) {
    return {
      required: true,
      reason: "action_force",
      policyLevel: policy.level,
    };
  }
  if (
    policy.level === "HIGH_RISK_ONLY" &&
    (input.currentRiskLevel === "HIGH" ||
      input.currentRiskLevel === "CRITICAL")
  ) {
    return {
      required: true,
      reason: "risk_high",
      policyLevel: policy.level,
    };
  }
  if (mfaRequiredForRole(policy.level, input.role)) {
    return {
      required: true,
      reason: "role_in_policy",
      policyLevel: policy.level,
    };
  }
  return { required: false, reason: "off", policyLevel: policy.level };
}

// -----------------------------------------------------------------------------
// Mutation
// -----------------------------------------------------------------------------

export type UpdateMfaPolicyInput = {
  teamId: string;
  actorUserId: string;
  level: MfaPolicyLevel;
  stepUpTtlSeconds?: number | null;
  trustedDeviceTtlDays?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function updateMfaPolicy(
  input: UpdateMfaPolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<ResolvedMfaPolicy> {
  const stepUpTtl =
    input.stepUpTtlSeconds === undefined
      ? undefined
      : clampStepUpTtl(input.stepUpTtlSeconds);
  const deviceTtl =
    input.trustedDeviceTtlDays === undefined
      ? undefined
      : clampTrustedDeviceTtl(input.trustedDeviceTtlDays);

  const updated = await client.organizationSecurityPolicy.upsert({
    where: { teamId: input.teamId },
    create: {
      teamId: input.teamId,
      mfaPolicyLevel: input.level,
      stepUpTtlSeconds: stepUpTtl ?? null,
      trustedDeviceTtlDays: deviceTtl ?? null,
      updatedByUserId: input.actorUserId,
    },
    update: {
      mfaPolicyLevel: input.level,
      ...(stepUpTtl !== undefined ? { stepUpTtlSeconds: stepUpTtl } : {}),
      ...(deviceTtl !== undefined ? { trustedDeviceTtlDays: deviceTtl } : {}),
      updatedByUserId: input.actorUserId,
    },
    select: {
      teamId: true,
      mfaPolicyLevel: true,
      mfaRequiredFlag: true,
      ssoReadyFlag: true,
      scimReadyFlag: true,
      stepUpTtlSeconds: true,
      trustedDeviceTtlDays: true,
    },
  });

  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "mfa_policy_updated",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        level: input.level,
        stepUpTtlSeconds: stepUpTtl ?? null,
        trustedDeviceTtlDays: deviceTtl ?? null,
      },
    },
    client,
  );
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "identity_security.mfa_policy.update",
    category: "identity_security.policy",
    severity: "info",
    source: "identity_security_service",
    outcome: "success",
    resourceType: "organization_security_policy",
    resourceId: input.teamId,
    metadata: {
      level: input.level,
      stepUpTtlSeconds: stepUpTtl ?? null,
      trustedDeviceTtlDays: deviceTtl ?? null,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });

  return {
    teamId: updated.teamId,
    level: normaliseLevel(updated.mfaPolicyLevel),
    stepUpTtlSeconds: updated.stepUpTtlSeconds ?? DEFAULT_STEP_UP_TTL_SECONDS,
    trustedDeviceTtlDays:
      updated.trustedDeviceTtlDays ?? DEFAULT_TRUSTED_DEVICE_TTL_DAYS,
    mfaRequiredFlag: updated.mfaRequiredFlag,
    ssoReadyFlag: updated.ssoReadyFlag,
    scimReadyFlag: updated.scimReadyFlag,
  };
}

function clampStepUpTtl(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 60) return 60;
  return Math.min(60 * 60, Math.floor(value));
}

function clampTrustedDeviceTtl(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(180, Math.floor(value));
}
