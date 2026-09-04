/**
 * Phase P3.1 — Key rotation lifecycle.
 *
 * Operator-driven rotation: stage → preview → promote → retire/revoke.
 *
 * Lifecycle transitions are recorded as `SecurityEvent` rows so the
 * registry (read-model) can reconstruct state without a new Prisma
 * table. Transitions are deliberately one-way (no "un-stage" path —
 * a stale staged signer becomes operationally inert after preview
 * compares it to the current env).
 *
 * Hard rules:
 *   * Historical artifact rows (Report.pdfSignerKeyId,
 *     VerificationPackage.* signing fields) are NEVER mutated by
 *     this service. Promotion only writes the audit event; the env
 *     swap is the operational step.
 *   * Promote / retire / revoke are step-up gated at the route layer.
 *   * Preview is read-only and idempotent.
 *   * Compatibility check uses bounded outcomes; no free-form text
 *     reaches the operator.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { bump } from "../ops/metrics.service.js";
// Phase O1.5 — bounded signer rotation spans. Attributes carry only
// bounded fields (teamId, signerPurpose, compatibility outcome).
// NEVER the key material, KMS credentials, or actor PII.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";
import {
  getCurrentActiveSigners,
  listAllSigners,
  listStagedSigners,
  SIGNER_PROVIDERS,
  SIGNER_PURPOSES,
  type SignerProvider,
  type SignerPurpose,
} from "./signer-registry.service.js";
import {
  countRemainingUsableSigners,
  getSignerControlStates,
  getEffectiveSignerStatus,
  isTransitionAllowed,
  transitionSignerControlState,
  type SignerControlStatus,
} from "./signer-control-state.service.js";

// ---------------------------------------------------------------------------
// Stage a new signer
// ---------------------------------------------------------------------------

export type StageSignerInput = {
  teamId: string;
  actorUserId: string;
  signerPurpose: SignerPurpose;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  kmsKeyArn: string | null;
  algorithm: string | null;
  notes: string | null;
};

export type StageSignerResult =
  | { ok: true; signerId: string; stagedAtUtc: string }
  | {
      ok: false;
      code: "invalid_purpose" | "invalid_provider" | "duplicate_staged";
      message: string;
    };

export async function stageSigner(
  input: StageSignerInput,
  client: PrismaClient = defaultPrisma,
): Promise<StageSignerResult> {
  if (!(SIGNER_PURPOSES as readonly string[]).includes(input.signerPurpose)) {
    return {
      ok: false,
      code: "invalid_purpose",
      message: "Signer purpose not in bounded set.",
    };
  }
  if (!(SIGNER_PROVIDERS as readonly string[]).includes(input.provider)) {
    return {
      ok: false,
      code: "invalid_provider",
      message: "Signer provider not in bounded set.",
    };
  }
  const signerId = `${input.signerPurpose}:${input.provider}:${
    input.keyId ?? "_"
  }:${input.keyVersion ?? "_"}`;
  const existing = await listStagedSigners(
    { teamId: input.teamId },
    client,
  );
  if (existing.some((s) => s.signerId === signerId && s.status === "staged")) {
    return {
      ok: false,
      code: "duplicate_staged",
      message: "A staged signer with this id already exists.",
    };
  }
  const stagedAtUtc = new Date().toISOString();
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "signer_staged",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      signerId,
      signerPurpose: input.signerPurpose,
      provider: input.provider,
      keyId: input.keyId,
      keyVersion: input.keyVersion,
      kmsKeyArn: input.kmsKeyArn,
      algorithm: input.algorithm,
      notes: input.notes,
    },
  });
  return { ok: true, signerId, stagedAtUtc };
}

// ---------------------------------------------------------------------------
// Rotation preview
// ---------------------------------------------------------------------------

export type RotationCompatibility =
  | "compatible"
  | "algorithm_change"
  | "provider_change"
  | "purpose_change"
  | "unverifiable";

export type RotationPreview = {
  signerPurpose: SignerPurpose;
  currentActive: {
    signerId: string;
    provider: SignerProvider;
    keyId: string | null;
    keyVersion: string | null;
    algorithm: string | null;
  } | null;
  staged: {
    signerId: string;
    provider: SignerProvider;
    keyId: string | null;
    keyVersion: string | null;
    algorithm: string | null;
  };
  compatibility: RotationCompatibility;
  /** Bounded warning codes operator must read. */
  warnings: ReadonlyArray<
    | "ALGORITHM_CHANGE"
    | "PROVIDER_CHANGE"
    | "PURPOSE_CHANGE"
    | "HISTORICAL_ARTIFACTS_REMAIN_UNCHANGED"
    | "VERIFICATION_MATERIAL_UNPUBLISHED"
  >;
  /** Operator-facing one-liner. */
  rolloutPlan: string;
  generatedAtUtc: string;
};

export async function previewRotation(
  input: { teamId: string; signerId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; preview: RotationPreview }
  | { ok: false; code: "staged_not_found"; message: string }
> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIGNER_ROTATION_PREVIEW,
    {
      "proovra.team_id": input.teamId,
      "proovra.operation": "signer_rotation_preview",
    },
    () => previewRotationInner(input, client),
  );
}

async function previewRotationInner(
  input: { teamId: string; signerId: string; actorUserId: string },
  client: PrismaClient,
): Promise<
  | { ok: true; preview: RotationPreview }
  | { ok: false; code: "staged_not_found"; message: string }
> {
  const staged = await listStagedSigners({ teamId: input.teamId }, client);
  const target = staged.find(
    (s) => s.signerId === input.signerId && s.status === "staged",
  );
  if (!target) {
    return {
      ok: false,
      code: "staged_not_found",
      message: "Staged signer not found.",
    };
  }
  const active = getCurrentActiveSigners().find(
    (a) => a.signerPurpose === target.signerPurpose && a.status === "active",
  );
  const warnings: RotationPreview["warnings"][number][] = [];
  let compatibility: RotationCompatibility = "compatible";
  if (active) {
    if (active.algorithm !== target.algorithm) {
      compatibility = "algorithm_change";
      warnings.push("ALGORITHM_CHANGE");
    }
    if (active.provider !== target.provider) {
      compatibility = "provider_change";
      warnings.push("PROVIDER_CHANGE");
    }
  } else {
    compatibility = "unverifiable";
  }
  // Historical immutability is ALWAYS a warning — operator must read it.
  warnings.push("HISTORICAL_ARTIFACTS_REMAIN_UNCHANGED");

  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "signer_rotation_previewed",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      signerId: input.signerId,
      compatibility,
    },
  });
  return {
    ok: true,
    preview: {
      signerPurpose: target.signerPurpose,
      currentActive: active
        ? {
            signerId: active.signerId,
            provider: active.provider,
            keyId: active.keyId,
            keyVersion: active.keyVersion,
            algorithm: active.algorithm,
          }
        : null,
      staged: {
        signerId: target.signerId,
        provider: target.provider,
        keyId: target.keyId,
        keyVersion: target.keyVersion,
        algorithm: target.algorithm,
      },
      compatibility,
      warnings,
      rolloutPlan:
        "Promote the staged signer to active. Old artifacts retain their original signer metadata. Re-deploy the api + worker with the env variables matching the staged signer to make the rotation operationally effective.",
      generatedAtUtc: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Promote / Retire / Revoke
// ---------------------------------------------------------------------------

export async function promoteStagedSigner(
  input: {
    teamId: string;
    actorUserId: string;
    signerId: string;
    reason: string;
    expectedStateVersion?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; promotedAtUtc: string }
  | {
      ok: false;
      code: "staged_not_found" | "reason_required" | "stale_state";
      message: string;
    }
> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIGNER_ROTATION_PROMOTE,
    {
      "proovra.team_id": input.teamId,
      "proovra.operation": "signer_rotation_promote",
    },
    () => promoteStagedSignerInner(input, client),
  );
}

async function promoteStagedSignerInner(
  input: {
    teamId: string;
    actorUserId: string;
    signerId: string;
    reason: string;
    expectedStateVersion?: number;
  },
  client: PrismaClient,
): Promise<
  | { ok: true; promotedAtUtc: string }
  | {
      ok: false;
      code: "staged_not_found" | "reason_required" | "stale_state";
      message: string;
    }
> {
  if ((input.reason ?? "").trim().length === 0) {
    return {
      ok: false,
      code: "reason_required",
      message: "Operator reason required for signer promotion.",
    };
  }
  const staged = await listStagedSigners({ teamId: input.teamId }, client);
  const target = staged.find(
    (s) => s.signerId === input.signerId && s.status === "staged",
  );
  if (!target) {
    return {
      ok: false,
      code: "staged_not_found",
      message: "Staged signer not found.",
    };
  }
  /*
   * The compare-and-set the route documents.
   *
   * `expectedStateVersion` was parsed by the promote route and then dropped on
   * the floor — retire and revoke both honour it, promote alone did not. A
   * caller sending it believed a signer that moved while their dialog was open
   * would be refused; instead the promotion went through against whatever the
   * signer had become. It is checked against the same persisted control state
   * those two transitions use, so all three agree on what "the state I was
   * looking at" means. An absent row is version 0 — a signer nobody has
   * transitioned yet.
   */
  if (input.expectedStateVersion !== undefined) {
    const states = await getSignerControlStates([input.signerId]);
    const currentVersion = states.get(input.signerId)?.stateVersion ?? 0;
    if (currentVersion !== input.expectedStateVersion) {
      return {
        ok: false,
        code: "stale_state",
        message:
          "This signer changed since the page was loaded. Reload and review the current state before promoting it.",
      };
    }
  }
  bump("signer_rotation_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "signer_promoted",
    severity: "WARNING",
    details: {
      actorUserId: input.actorUserId,
      signerId: input.signerId,
      signerPurpose: target.signerPurpose,
      provider: target.provider,
      keyId: target.keyId,
      keyVersion: target.keyVersion,
      reason: input.reason.trim().slice(0, 240),
    },
  });
  return { ok: true, promotedAtUtc: new Date().toISOString() };
}

/**
 * REAL retirement and revocation.
 *
 * Both of these used to validate a reason, bump a counter, emit a security
 * event and return `{ ok: true }`. Nothing was written, the signer id was never
 * checked to exist, and the read model recomputed the signer as ACTIVE from the
 * environment on the very next request. The dialog promised an irreversible
 * security outcome that had not happened.
 *
 * They now drive the persisted control state, which is what the signing
 * boundary reads before producing any signature. The audit event is still
 * emitted — but only when a transition actually CHANGED something, so an
 * idempotent retry does not manufacture a second "first revocation" in the log.
 */

export type SignerLifecycleResult =
  | { ok: true; state: "changed"; status: SignerControlStatus; changedAtUtc: string }
  | { ok: true; state: "already"; status: SignerControlStatus }
  | {
      ok: false;
      code:
        | "reason_required"
        | "signer_not_found"
        | "transition_not_allowed"
        | "stale_state"
        | "last_active_signer";
      message: string;
    };

async function runSignerLifecycleTransition(
  input: {
    teamId: string;
    actorUserId: string;
    signerId: string;
    reason: string;
    expectedStateVersion?: number;
  },
  to: SignerControlStatus,
): Promise<SignerLifecycleResult> {
  const verb = to === "REVOKED" ? "revoke" : "retire";
  if ((input.reason ?? "").trim().length === 0) {
    return {
      ok: false,
      code: "reason_required",
      message: `Operator reason required for signer ${verb}.`,
    };
  }

  // The signer must exist. The route used to accept any string and answer 200.
  //
  // Existence is checked against the FULL read model — the env-configured
  // signers plus the staged ones — because that is what the console lists and
  // therefore what an operator can click Retire on. Checking only the
  // env-configured set would have made every staged signer un-transitionable
  // while still showing it the buttons.
  const visible = await listAllSigners({ teamId: input.teamId });
  const target = visible.find((s) => s.signerId === input.signerId);
  if (!target) {
    return {
      ok: false,
      code: "signer_not_found",
      message: "No configured signer with that id.",
    };
  }

  // Availability is a different question and is answered over a different set:
  // only a signer the deployment can actually sign WITH counts. A staged
  // signer is a promotable candidate, not a working one, so it must not be
  // treated as cover for retiring the signer currently in use.
  const configured = getCurrentActiveSigners();

  // LEGALITY BEFORE AVAILABILITY.
  //
  // These two refusals answer different questions, and the operator needs the
  // right one: "a revoked signer cannot be retired" is a statement about the
  // lifecycle, while "this would leave nothing able to sign" is a statement
  // about capacity. Running the capacity check first told someone trying to
  // retire an already-revoked signer that they had a availability problem they
  // did not have.
  const currentStatus = await getEffectiveSignerStatus(input.signerId);
  if (currentStatus !== to && !isTransitionAllowed(currentStatus, to)) {
    return {
      ok: false,
      code: "transition_not_allowed",
      message: `A ${currentStatus.toLowerCase()} signer cannot be ${
        to === "REVOKED" ? "revoked" : "retired"
      }.`,
    };
  }

  // AVAILABILITY. Retiring the last signer that can still sign for a purpose
  // would leave that purpose unable to sign, discovered at the next upload
  // rather than here. Retirement is a planned action and must not do that.
  //
  // Revocation is the compromise path and IS allowed to proceed: continuing to
  // sign with a key believed compromised is worse than being unable to sign.
  // The result reports the state truthfully rather than the system pretending
  // signing is still healthy.
  if (to === "RETIRED") {
    const remaining = await countRemainingUsableSigners({
      candidateSignerIds: configured
        .filter((s) => s.signerPurpose === target.signerPurpose)
        .map((s) => s.signerId),
      excluding: input.signerId,
    });
    if (remaining === 0) {
      return {
        ok: false,
        code: "last_active_signer",
        message:
          `Retiring this signer would leave ${target.signerPurpose} with no signer that can sign. ` +
          "Configure and verify a replacement first, or revoke it if the key is compromised.",
      };
    }
  }

  const outcome = await transitionSignerControlState({
    signerId: input.signerId,
    to,
    actorUserId: input.actorUserId,
    reason: input.reason,
    transitionSource: "admin_console",
    expectedStateVersion: input.expectedStateVersion,
  });

  if (!outcome.ok) {
    if (outcome.code === "not_found") {
      return {
        ok: false,
        code: "signer_not_found",
        message: "No configured signer with that id.",
      };
    }
    if (outcome.code === "stale_state") {
      return {
        ok: false,
        code: "stale_state",
        message:
          "This signer changed while the page was open. Reload and review the current state before acting.",
      };
    }
    return {
      ok: false,
      code: "transition_not_allowed",
      message: `A ${outcome.from.toLowerCase()} signer cannot be ${
        to === "REVOKED" ? "revoked" : "retired"
      }.`,
    };
  }

  // Idempotent repeat: nothing changed, so no transition is claimed or audited.
  if (outcome.state === "already") {
    return { ok: true, state: "already", status: outcome.status };
  }

  bump("signer_rotation_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: to === "REVOKED" ? "signer_revoked" : "signer_retired",
    severity: to === "REVOKED" ? "HIGH" : "WARNING",
    details: {
      actorUserId: input.actorUserId,
      signerId: input.signerId,
      previousStatus: outcome.from,
      newStatus: outcome.to,
      stateVersion: outcome.stateVersion,
      reason: input.reason.trim().slice(0, 240),
    },
  });

  return {
    ok: true,
    state: "changed",
    status: to,
    changedAtUtc: new Date().toISOString(),
  };
}

export async function retireSigner(input: {
  teamId: string;
  actorUserId: string;
  signerId: string;
  reason: string;
  expectedStateVersion?: number;
}): Promise<SignerLifecycleResult> {
  return runSignerLifecycleTransition(input, "RETIRED");
}

export async function revokeSigner(input: {
  teamId: string;
  actorUserId: string;
  signerId: string;
  reason: string;
  expectedStateVersion?: number;
}): Promise<SignerLifecycleResult> {
  return runSignerLifecycleTransition(input, "REVOKED");
}

// ---------------------------------------------------------------------------
// Signer audit timeline
// ---------------------------------------------------------------------------

export type SignerAuditEntry = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  actorUserId: string | null;
  signerId: string | null;
  summary: string;
};

const SIGNER_AUDIT_EVENT_TYPES = [
  "signer_staged",
  "signer_health_checked",
  "signer_health_degraded",
  "signer_rotation_previewed",
  "signer_promoted",
  "signer_retired",
  "signer_revoked",
  "signer_signature_failure",
] as const;

export async function listSignerAudit(
  input: { teamId: string; signerId?: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<SignerAuditEntry>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      eventType: { in: SIGNER_AUDIT_EVENT_TYPES as unknown as string[] },
    },
    orderBy: { createdAt: "desc" },
    take: limit * 2, // filter then cap
    select: {
      id: true,
      eventType: true,
      severity: true,
      createdAt: true,
      details: true,
    },
  });
  const out: SignerAuditEntry[] = [];
  for (const row of rows) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const sid = typeof d.signerId === "string" ? d.signerId : null;
    if (input.signerId && sid !== input.signerId) continue;
    out.push({
      id: row.id,
      occurredAtUtc: row.createdAt.toISOString(),
      eventType: row.eventType,
      severity: (row.severity as "INFO" | "WARNING" | "HIGH") ?? "INFO",
      actorUserId:
        typeof d.actorUserId === "string" ? d.actorUserId : null,
      signerId: sid,
      summary: humaniseSignerEvent(row.eventType),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function humaniseSignerEvent(eventType: string): string {
  switch (eventType) {
    case "signer_staged":
      return "Operator staged a new signer";
    case "signer_health_checked":
      return "Signer health probe ran";
    case "signer_health_degraded":
      return "Signer health degraded";
    case "signer_rotation_previewed":
      return "Rotation preview generated";
    case "signer_promoted":
      return "Staged signer promoted to active (step-up confirmed)";
    case "signer_retired":
      return "Signer retired";
    case "signer_revoked":
      return "Signer revoked";
    case "signer_signature_failure":
      return "Signing operation failed";
    default:
      return "Signer event";
  }
}
