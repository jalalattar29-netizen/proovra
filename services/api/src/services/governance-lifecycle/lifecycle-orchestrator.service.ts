/**
 * Phase 27 — Evidence Lifecycle Orchestrator.
 *
 * The CANONICAL writer for `Evidence.lifecycleState`. Every transition
 * goes through this module; the Evidence row is NEVER updated directly
 * from any other service.
 *
 * Hard rules:
 *   - Transitions are validated against the shared
 *     `EVIDENCE_LIFECYCLE_TRANSITIONS` table. Any transition outside
 *     the table is REFUSED with `LIFECYCLE_INVALID_TRANSITION`.
 *   - Hold-aware: while a hold is active on the evidence (or on its
 *     case), transitions TO `PENDING_DESTRUCTION` or `DESTROYED` are
 *     refused with `LIFECYCLE_BLOCKED_BY_HOLD`.
 *   - Immutable retention: if the effective retention policy carries
 *     `immutable=true`, transitions to `PENDING_DESTRUCTION` /
 *     `DESTROYED` are refused with `LIFECYCLE_BLOCKED_BY_IMMUTABLE`.
 *   - Append-only ledger: every transition writes one
 *     `EvidenceLifecycleEvent`. Non-transition events (hold placed /
 *     released, policy attached, restore requested) use
 *     `recordLifecycleEvent`.
 *   - DESTROYED is terminal at the state-machine level. Operators
 *     CANNOT re-transition out of DESTROYED.
 *
 * Metrics + events:
 *   - bump("lifecycle_transition_total") on success
 *   - bump("lifecycle_transition_blocked_total") on refusal
 *   - safeEmitSecurityEvent({eventType: "lifecycle_transition" |
 *     "lifecycle_transition_blocked", ...})
 *   - audit via appendPlatformAuditLog (category: "governance")
 */

import type {
  PrismaClient,
  EvidenceLifecycleEvent as DbLifecycleEvent,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  EVIDENCE_LIFECYCLE_STATES,
  isAllowedEvidenceLifecycleTransition,
  isTerminalLifecycleState,
  LIFECYCLE_EVENT_TYPES,
  type EvidenceLifecycleState,
  type LifecycleEventType,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export type LifecycleOrchestratorErrorCode =
  | "LIFECYCLE_EVIDENCE_NOT_FOUND"
  | "LIFECYCLE_INVALID_TRANSITION"
  | "LIFECYCLE_BLOCKED_BY_HOLD"
  | "LIFECYCLE_BLOCKED_BY_IMMUTABLE"
  | "LIFECYCLE_TERMINAL_STATE"
  | "LIFECYCLE_INVALID_EVENT_TYPE";

export class LifecycleOrchestratorError extends Error {
  constructor(
    public readonly code: LifecycleOrchestratorErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "LifecycleOrchestratorError";
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const VALID_STATES = new Set<string>(EVIDENCE_LIFECYCLE_STATES);
const VALID_EVENT_TYPES = new Set<string>(LIFECYCLE_EVENT_TYPES);

const MAX_SUMMARY_LEN = 400;
const MAX_METADATA_BYTES = 8 * 1024;

/**
 * Scrub known-sensitive keys from operator metadata before persistence.
 * Lifecycle events are visible to compliance reviewers; they must never
 * carry privileged legal text or PII. Catalog-bound — only known
 * structured fields survive.
 */
const SENSITIVE_KEY_PREFIXES = [
  "legalnote",
  "privileged",
  "secret",
  "token",
  "credential",
  "password",
  "apikey",
  "api_key",
] as const;

function scrubMetadata(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    if (typeof input === "string") return input.slice(0, 1000);
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 50).map(scrubMetadata);
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (i >= 50) break;
    const lowered = String(k).toLowerCase();
    if (SENSITIVE_KEY_PREFIXES.some((p) => lowered.includes(p))) {
      out[String(k).slice(0, 64)] = "[redacted]";
    } else {
      out[String(k).slice(0, 64)] = scrubMetadata(v);
    }
    i += 1;
  }
  return out;
}

function boundedMetadata(input: unknown): prismaPkg.Prisma.InputJsonValue | null {
  if (input === null || input === undefined) return null;
  const scrubbed = scrubMetadata(input);
  try {
    const s = JSON.stringify(scrubbed);
    if (s.length > MAX_METADATA_BYTES) {
      return {
        truncated: true,
        preview: s.slice(0, 1500),
      } as prismaPkg.Prisma.InputJsonValue;
    }
    return scrubbed as prismaPkg.Prisma.InputJsonValue;
  } catch {
    return { truncated: true } as prismaPkg.Prisma.InputJsonValue;
  }
}

async function evidenceHasActiveHold(
  evidenceId: string,
  client: PrismaClient,
): Promise<boolean> {
  const direct = await client.evidenceLegalHold.findFirst({
    where: { evidenceId, status: prismaPkg.LegalHoldStatus.ACTIVE },
    select: { id: true },
  });
  if (direct) return true;
  // Cascade through case-level holds.
  const ev = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: { caseId: true },
  });
  if (!ev?.caseId) return false;
  const caseHold = await client.caseLegalHold.findFirst({
    where: { caseId: ev.caseId, status: prismaPkg.CaseLegalHoldStatus.ACTIVE },
    select: { id: true },
  });
  return Boolean(caseHold);
}

async function evidenceHasImmutableRetention(
  evidenceId: string,
  client: PrismaClient,
): Promise<boolean> {
  // The Evidence row points at a RetentionPolicyVersion (Phase 27).
  // If the version snapshot says immutable=true, destruction is
  // refused regardless of expiry.
  const ev = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: { retentionPolicyVersionId: true },
  });
  if (!ev?.retentionPolicyVersionId) return false;
  const version = await client.evidenceRetentionPolicyVersion.findUnique({
    where: { id: ev.retentionPolicyVersionId },
    select: { immutable: true },
  });
  return Boolean(version?.immutable);
}

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type LifecycleEventProjection = {
  id: string;
  teamId: string;
  evidenceId: string;
  fromState: EvidenceLifecycleState | null;
  toState: EvidenceLifecycleState;
  eventType: LifecycleEventType;
  summary: string;
  metadata: unknown;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: string;
};

export function projectLifecycleEvent(
  row: DbLifecycleEvent,
): LifecycleEventProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    evidenceId: row.evidenceId,
    fromState: row.fromState as EvidenceLifecycleState | null,
    toState: row.toState as EvidenceLifecycleState,
    eventType: row.eventType as LifecycleEventType,
    summary: row.summary,
    metadata: row.metadata,
    actorUserId: row.actorUserId,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Pre-flight: ask whether a transition WOULD succeed.
// -----------------------------------------------------------------------------

export type LifecyclePreflightResult =
  | { allowed: true; fromState: EvidenceLifecycleState }
  | {
      allowed: false;
      code: LifecycleOrchestratorErrorCode;
      fromState: EvidenceLifecycleState;
    };

export async function preflightLifecycleTransition(
  input: {
    teamId: string;
    evidenceId: string;
    toState: EvidenceLifecycleState;
  },
  client: PrismaClient = defaultPrisma,
): Promise<LifecyclePreflightResult> {
  if (!VALID_STATES.has(input.toState)) {
    throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
      toState: input.toState,
    });
  }
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { lifecycleState: true },
  });
  if (!ev) {
    throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
  }
  const fromState = ev.lifecycleState as EvidenceLifecycleState;
  if (isTerminalLifecycleState(fromState) && fromState !== input.toState) {
    return { allowed: false, code: "LIFECYCLE_TERMINAL_STATE", fromState };
  }
  if (!isAllowedEvidenceLifecycleTransition(fromState, input.toState)) {
    return { allowed: false, code: "LIFECYCLE_INVALID_TRANSITION", fromState };
  }
  if (
    input.toState === "PENDING_DESTRUCTION" ||
    input.toState === "DESTROYED"
  ) {
    if (await evidenceHasActiveHold(input.evidenceId, client)) {
      return { allowed: false, code: "LIFECYCLE_BLOCKED_BY_HOLD", fromState };
    }
    if (await evidenceHasImmutableRetention(input.evidenceId, client)) {
      return {
        allowed: false,
        code: "LIFECYCLE_BLOCKED_BY_IMMUTABLE",
        fromState,
      };
    }
  }
  return { allowed: true, fromState };
}

// -----------------------------------------------------------------------------
// Transition
// -----------------------------------------------------------------------------

export type TransitionLifecycleInput = {
  teamId: string;
  evidenceId: string;
  toState: EvidenceLifecycleState;
  actorUserId: string | null;
  summary: string;
  eventType?: LifecycleEventType;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
};

export type TransitionLifecycleResult = {
  fromState: EvidenceLifecycleState;
  toState: EvidenceLifecycleState;
  lifecycleEvent: LifecycleEventProjection;
};

export async function transitionLifecycle(
  input: TransitionLifecycleInput,
  client: PrismaClient = defaultPrisma,
): Promise<TransitionLifecycleResult> {
  if (!VALID_STATES.has(input.toState)) {
    throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
      toState: input.toState,
    });
  }
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { id: true, lifecycleState: true },
  });
  if (!ev) {
    throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
  }
  const fromState = ev.lifecycleState as EvidenceLifecycleState;

  // Self-transition is a no-op heartbeat — we still write a ledger
  // row so the operator timeline records the request, but no
  // metric/security event fires.
  if (fromState === input.toState) {
    const event = await client.evidenceLifecycleEvent.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        fromState,
        toState: input.toState,
        eventType: input.eventType ?? "lifecycle_transition",
        summary: input.summary.slice(0, MAX_SUMMARY_LEN),
        metadata: boundedMetadata({
          ...(input.metadata ?? {}),
          noop: true,
        }) ?? undefined,
        actorUserId: input.actorUserId,
        requestId: input.requestId?.slice(0, 64) ?? null,
      },
    });
    return {
      fromState,
      toState: input.toState,
      lifecycleEvent: projectLifecycleEvent(event),
    };
  }

  if (isTerminalLifecycleState(fromState)) {
    bump("lifecycle_transition_blocked_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "lifecycle_transition_blocked",
      severity: "WARNING",
      evidenceId: input.evidenceId,
      details: {
        fromState,
        toState: input.toState,
        reason: "terminal_state",
        actorUserId: input.actorUserId,
      },
    });
    throw new LifecycleOrchestratorError("LIFECYCLE_TERMINAL_STATE", {
      fromState,
      toState: input.toState,
    });
  }

  if (!isAllowedEvidenceLifecycleTransition(fromState, input.toState)) {
    bump("lifecycle_transition_blocked_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "lifecycle_transition_blocked",
      severity: "WARNING",
      evidenceId: input.evidenceId,
      details: {
        fromState,
        toState: input.toState,
        reason: "invalid_transition",
        actorUserId: input.actorUserId,
      },
    });
    throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
      fromState,
      toState: input.toState,
    });
  }

  if (
    input.toState === "PENDING_DESTRUCTION" ||
    input.toState === "DESTROYED"
  ) {
    if (await evidenceHasActiveHold(input.evidenceId, client)) {
      bump("lifecycle_transition_blocked_total");
      bump("destruction_blocked_by_hold_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_blocked_by_hold",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: {
          fromState,
          toState: input.toState,
          actorUserId: input.actorUserId,
        },
      });
      throw new LifecycleOrchestratorError("LIFECYCLE_BLOCKED_BY_HOLD", {
        fromState,
        toState: input.toState,
      });
    }
    if (await evidenceHasImmutableRetention(input.evidenceId, client)) {
      bump("lifecycle_transition_blocked_total");
      bump("destruction_blocked_by_immutable_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_blocked_by_immutable",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: {
          fromState,
          toState: input.toState,
          actorUserId: input.actorUserId,
        },
      });
      throw new LifecycleOrchestratorError("LIFECYCLE_BLOCKED_BY_IMMUTABLE", {
        fromState,
        toState: input.toState,
      });
    }
  }

  // Mutation + ledger write happen in the same transaction so the
  // pointer + ledger stay consistent.
  const lifecycleEvent = await client.$transaction(async (tx) => {
    await tx.evidence.update({
      where: { id: input.evidenceId },
      data: {
        lifecycleState: input.toState as prismaPkg.EvidenceLifecycleState,
      },
    });
    return tx.evidenceLifecycleEvent.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        fromState,
        toState: input.toState,
        eventType: input.eventType ?? "lifecycle_transition",
        summary: input.summary.slice(0, MAX_SUMMARY_LEN),
        metadata: boundedMetadata(input.metadata) ?? undefined,
        actorUserId: input.actorUserId,
        requestId: input.requestId?.slice(0, 64) ?? null,
      },
    });
  });

  bump("lifecycle_transition_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "evidence_lifecycle_transition",
    severity: "INFO",
    evidenceId: input.evidenceId,
    details: {
      fromState,
      toState: input.toState,
      actorUserId: input.actorUserId,
    },
  });
  if (input.actorUserId) {
    await emitTenantAudit({
      action: "lifecycle.transition",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "evidence",
      resourceId: input.evidenceId,
      correlationId: input.requestId ?? null,
      metadata: {
        fromState,
        toState: input.toState,
      },
    }, client);
  }

  return {
    fromState,
    toState: input.toState,
    lifecycleEvent: projectLifecycleEvent(lifecycleEvent),
  };
}

// -----------------------------------------------------------------------------
// Record a non-transition lifecycle event (hold placed/released, policy
// attached, etc). Lifecycle state is left unchanged.
// -----------------------------------------------------------------------------

export type RecordLifecycleEventInput = {
  teamId: string;
  evidenceId: string;
  eventType: LifecycleEventType;
  summary: string;
  actorUserId: string | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
};

export async function recordLifecycleEvent(
  input: RecordLifecycleEventInput,
  client: PrismaClient = defaultPrisma,
): Promise<LifecycleEventProjection> {
  if (!VALID_EVENT_TYPES.has(input.eventType)) {
    throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_EVENT_TYPE", {
      eventType: input.eventType,
    });
  }
  const ev = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: { lifecycleState: true },
  });
  if (!ev) {
    throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
  }
  const row = await client.evidenceLifecycleEvent.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      fromState: ev.lifecycleState,
      toState: ev.lifecycleState,
      eventType: input.eventType,
      summary: input.summary.slice(0, MAX_SUMMARY_LEN),
      metadata: boundedMetadata(input.metadata) ?? undefined,
      actorUserId: input.actorUserId,
      requestId: input.requestId?.slice(0, 64) ?? null,
    },
  });
  return projectLifecycleEvent(row);
}

// -----------------------------------------------------------------------------
// Read — operator timeline.
// -----------------------------------------------------------------------------

export type ListLifecycleEventsInput = {
  teamId: string;
  evidenceId: string;
  limit?: number;
};

export async function listLifecycleEvents(
  input: ListLifecycleEventsInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<LifecycleEventProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await client.evidenceLifecycleEvent.findMany({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(projectLifecycleEvent);
}

// -----------------------------------------------------------------------------
// Dashboard counts — gauge feeders.
// -----------------------------------------------------------------------------

export async function countByLifecycleState(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Record<EvidenceLifecycleState, number>> {
  const rows = await client.evidence.groupBy({
    by: ["lifecycleState"],
    where: { teamId },
    _count: { _all: true },
  });
  const out: Record<EvidenceLifecycleState, number> = {
    ACTIVE: 0,
    UNDER_REVIEW: 0,
    ON_HOLD: 0,
    RETENTION_LOCKED: 0,
    PENDING_DESTRUCTION: 0,
    DESTROYED: 0,
    ARCHIVED: 0,
  };
  for (const r of rows) {
    const k = r.lifecycleState as EvidenceLifecycleState;
    if (k in out) out[k] = r._count._all;
  }
  return out;
}
