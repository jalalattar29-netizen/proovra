/**
 * PHASE 12B CLUSTER 8 — THE canonical Legal-Hold domain authority.
 *
 * ONE placement command, ONE release command, ONE effective-hold evaluator
 * (re-exported from ./effective-legal-hold.js), ONE destruction-gate
 * integration, ONE audit/custody path — for ALL scopes.
 *
 * Before this service the domain had three command surfaces that disagreed:
 *
 *   * `governance.service.ts#placeLegalHold`      — evidence only, step-up
 *     gated, custody event, webhook, NO release-approval gate on release.
 *   * `governance/case-legal-hold.service.ts`     — case only, custody event
 *     fan-out, release-approval gate at the ROUTE, no step-up on place.
 *   * `lifecycle/legal-hold.service.ts`           — scope-generic, webhook
 *     only, no custody event, no release note, no approval gate.
 *
 * Everything they enforced is preserved here and now applies to every scope:
 *   - step-up (LEGAL_HOLD_PLACE / LEGAL_HOLD_RELEASE) stays at the route
 *     layer, where the request context lives, and is required by every
 *     placement and release route regardless of scope;
 *   - the WorkspaceGovernancePolicy `requireLegalHoldReleaseApproval` gate is
 *     captured ON the hold at placement time and enforced here on release,
 *     so a later policy relaxation cannot retroactively unlock a hold that
 *     was placed under approval;
 *   - a release note is mandatory;
 *   - custody events are appended for every affected evidence row;
 *   - optimistic concurrency through the `version` column (stale = 409).
 *
 * TENANCY. `teamId` is the tenant authority on EVERY read and write. A hold
 * is never created against a target in another workspace and never resolved
 * across workspaces — cross-workspace lookups return "not found", never a
 * merged view.
 *
 * WORDING. Holds do NOT assert legal admissibility, authenticity or
 * evidentiary truth. They are INTERNAL preservation controls that flag a
 * record as preserved-pending-review.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { triggerLegalHoldCreated } from "../automation/automation-triggers.js";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { emitWebhookEvent } from "../integrations/webhook-dispatcher.js";
import {
  evaluateEffectiveLegalHold,
  isUnderEffectiveLegalHold,
  resolveLinkedCaseIds,
  type EffectiveLegalHoldResult,
} from "./effective-legal-hold.js";

// The ONE evaluator is re-exported from the ONE service so consumers never
// have to know which module holds the union rule.
export {
  evaluateEffectiveLegalHold,
  isUnderEffectiveLegalHold,
  resolveLinkedCaseIds,
};
export type { EffectiveLegalHoldResult };

export type CanonicalLegalHoldScope = "EVIDENCE" | "CASE" | "WORKSPACE";
export type CanonicalLegalHoldStatus = "ACTIVE" | "RELEASED" | "EXPIRED";

export type LegalHoldErrorCode =
  | "scope_target_required"
  | "target_not_in_workspace"
  | "hold_not_found"
  | "release_note_required"
  | "release_approval_required"
  | "stale_version";

const STATUS_CODES: Record<LegalHoldErrorCode, number> = {
  scope_target_required: 422,
  target_not_in_workspace: 404,
  hold_not_found: 404,
  release_note_required: 422,
  release_approval_required: 403,
  stale_version: 409,
};

export class LegalHoldError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: LegalHoldErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "LegalHoldError";
    this.statusCode = STATUS_CODES[code];
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const CANONICAL_SELECT = {
  id: true,
  teamId: true,
  scope: true,
  evidenceId: true,
  caseId: true,
  organizationId: true,
  title: true,
  reason: true,
  status: true,
  placedByUserId: true,
  placedAtUtc: true,
  releasedByUserId: true,
  releasedAtUtc: true,
  releaseNote: true,
  expiresAtUtc: true,
  releaseApprovalRequired: true,
  releaseApprovalState: true,
  releaseApprovedByUserId: true,
  releaseApprovedAtUtc: true,
  policyVersionAttribution: true,
  version: true,
  sourceStore: true,
  historical: true,
} as const;

export type CanonicalLegalHoldRow = {
  id: string;
  teamId: string;
  scope: string;
  evidenceId: string | null;
  caseId: string | null;
  organizationId: string | null;
  title: string;
  reason: string | null;
  status: string;
  placedByUserId: string;
  placedAtUtc: Date;
  releasedByUserId: string | null;
  releasedAtUtc: Date | null;
  releaseNote: string | null;
  expiresAtUtc: Date | null;
  releaseApprovalRequired: boolean;
  releaseApprovalState: string;
  releaseApprovedByUserId: string | null;
  releaseApprovedAtUtc: Date | null;
  policyVersionAttribution: string | null;
  version: number;
  sourceStore: string;
  historical: boolean;
};

export type CanonicalLegalHoldProjection = {
  id: string;
  teamId: string;
  scope: CanonicalLegalHoldScope;
  evidenceId: string | null;
  caseId: string | null;
  organizationId: string | null;
  title: string;
  status: string;
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
  expiresAtUtc: string | null;
  releaseApprovalRequired: boolean;
  releaseApprovalState: string;
  version: number;
  sourceStore: string;
  historical: boolean;
};

/**
 * Internal-only fields (`reason`, `releaseNote`, policy attribution) are
 * DELIBERATELY omitted — they are workspace-internal context and must never
 * reach a public verify, external intake or unauthenticated surface.
 */
export function projectCanonicalLegalHold(
  hold: CanonicalLegalHoldRow,
): CanonicalLegalHoldProjection {
  return {
    id: hold.id,
    teamId: hold.teamId,
    scope: hold.scope as CanonicalLegalHoldScope,
    evidenceId: hold.evidenceId,
    caseId: hold.caseId,
    organizationId: hold.organizationId,
    title: hold.title,
    status: hold.status,
    placedByUserId: hold.placedByUserId,
    placedAtUtc: hold.placedAtUtc.toISOString(),
    releasedByUserId: hold.releasedByUserId,
    releasedAtUtc: hold.releasedAtUtc?.toISOString() ?? null,
    expiresAtUtc: hold.expiresAtUtc?.toISOString() ?? null,
    releaseApprovalRequired: hold.releaseApprovalRequired,
    releaseApprovalState: hold.releaseApprovalState,
    version: hold.version,
    sourceStore: hold.sourceStore,
    historical: hold.historical,
  };
}

// ---------------------------------------------------------------------------
// Policy attribution
// ---------------------------------------------------------------------------

/**
 * Which WorkspaceGovernancePolicy revision governed this decision. Recorded on
 * the hold so a later policy edit can never rewrite the history of why a hold
 * was placed under approval (or was not).
 */
async function resolvePolicyAttribution(
  client: PrismaClient,
  teamId: string,
): Promise<{ attribution: string; requireReleaseApproval: boolean }> {
  try {
    const row = await client.workspaceGovernancePolicy.findUnique({
      where: { teamId },
      select: {
        id: true,
        updatedAt: true,
        requireLegalHoldReleaseApproval: true,
      },
    });
    if (!row) {
      return { attribution: "wgp:default", requireReleaseApproval: false };
    }
    return {
      attribution: `wgp:${row.id}@${row.updatedAt.toISOString()}`,
      requireReleaseApproval: row.requireLegalHoldReleaseApproval === true,
    };
  } catch {
    // Attribution is provenance, not a control. If the policy row cannot be
    // read we record that fact and fall back to the SAFER reading: approval
    // required. Never fall back to "no approval needed".
    return { attribution: "wgp:unresolved", requireReleaseApproval: true };
  }
}

// ---------------------------------------------------------------------------
// placeLegalHold — the ONE placement command, all scopes
// ---------------------------------------------------------------------------

export type PlaceCanonicalLegalHoldInput = {
  teamId: string;
  scope: CanonicalLegalHoldScope;
  /** Required for scope EVIDENCE. */
  evidenceId?: string | null;
  /** Required for scope CASE. */
  caseId?: string | null;
  actorUserId: string;
  title: string;
  reason?: string | null;
  expiresAtUtc?: Date | null;
};

export async function placeCanonicalLegalHold(
  input: PlaceCanonicalLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<CanonicalLegalHoldRow> {
  const scope = input.scope;
  let evidenceId: string | null = null;
  let caseId: string | null = null;

  if (scope === "EVIDENCE") {
    if (!input.evidenceId) throw new LegalHoldError("scope_target_required");
    // CROSS-WORKSPACE DENIAL — the target must live in the same tenant.
    const ev = await client.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { id: true, teamId: true },
    });
    if (!ev || ev.teamId !== input.teamId) {
      throw new LegalHoldError("target_not_in_workspace");
    }
    evidenceId = ev.id;
    // An evidence hold MAY record the case it arose from, but only when that
    // case is in the same workspace. This column is informational for
    // EVIDENCE scope: only scope='CASE' rows protect a whole case.
    caseId = null;
  } else if (scope === "CASE") {
    if (!input.caseId) throw new LegalHoldError("scope_target_required");
    const c = await client.case.findUnique({
      where: { id: input.caseId },
      select: { id: true, teamId: true },
    });
    if (!c || c.teamId !== input.teamId) {
      throw new LegalHoldError("target_not_in_workspace");
    }
    caseId = c.id;
  }

  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });
  const policy = await resolvePolicyAttribution(client, input.teamId);

  const hold = (await client.evidenceLegalHold.create({
    data: {
      teamId: input.teamId,
      scope,
      evidenceId,
      caseId,
      organizationId: team?.organizationId ?? null,
      title: input.title.slice(0, 180),
      reason: input.reason?.slice(0, 4000) ?? null,
      status: "ACTIVE",
      placedByUserId: input.actorUserId,
      expiresAtUtc: input.expiresAtUtc ?? null,
      releaseApprovalRequired: policy.requireReleaseApproval,
      releaseApprovalState: policy.requireReleaseApproval
        ? "PENDING"
        : "NOT_REQUIRED",
      policyVersionAttribution: policy.attribution,
      version: 1,
      sourceStore: "EVIDENCE_LEGAL_HOLD",
      sourceRowId: null,
      historical: false,
    },
    select: CANONICAL_SELECT,
  })) as CanonicalLegalHoldRow;

  /**
   * ARCH-005 (2026-08-07) — LEGAL_HOLD_CREATED, on the SAME client the hold
   * was written with. When that client is a transaction, the run commits with
   * the hold; when the caller is not in one, the hold is already durable by
   * the time this line runs. Either way there is no window in which a hold
   * exists and its trigger does not.
   */
  await triggerLegalHoldCreated(client, {
    teamId: input.teamId,
    holdId: hold.id,
    context: { scope: String(scope), status: "ACTIVE" },
  });

  await fanOutCustodyEvents(client, hold, "LEGAL_HOLD_PLACED", {
    legalHoldId: hold.id,
    scope,
    title: hold.title,
    placedByUserId: input.actorUserId,
  });

  // PHASE 12 POINT 3 — template-identity provenance on the outbound event.
  // The retired scope-generic writer enriched its webhook with the evidence
  // template trio for downstream traceability. Porting it here keeps that
  // capability when the legacy writer goes, rather than losing it silently.
  // Identity-only; it never drives a lifecycle decision, and a lookup failure
  // must never break the hold flow.
  let templateProvenance: {
    templateSlug: string | null;
    templateVersion: number | null;
    templateDbId: string | null;
  } = { templateSlug: null, templateVersion: null, templateDbId: null };
  if (scope === "EVIDENCE" && evidenceId) {
    try {
      const ev = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: {
          templateSlug: true,
          templateVersion: true,
          templateDbId: true,
        },
      });
      if (ev) {
        templateProvenance = {
          templateSlug: ev.templateSlug ?? null,
          templateVersion: ev.templateVersion ?? null,
          templateDbId: ev.templateDbId ?? null,
        };
      }
    } catch {
      /* identity propagation must never break the legal-hold flow */
    }
  }

  // Reason is NEVER projected onto the outbound webhook payload.
  await emitWebhookEvent({
    teamId: input.teamId,
    eventType: "governance.legal_hold_placed",
    payload: {
      legalHoldId: hold.id,
      scope,
      kind: scope,
      evidenceId,
      caseId,
      title: hold.title,
      placedAtUtc: hold.placedAtUtc.toISOString(),
      ...templateProvenance,
    },
    attemptInline: false,
  }).catch(() => null);

  // Second fan-out: the lifecycle webhook stream the scope-generic surface
  // used. Both are preserved so no existing subscriber loses an event.
  await emitLifecycleHoldWebhook(
    "LEGAL_HOLD_APPLIED",
    { holdId: hold.id, scope, scopeTargetId: evidenceId ?? caseId ?? input.teamId },
    { prisma: client, teamId: input.teamId },
  );

  return hold;
}

// ---------------------------------------------------------------------------
// releaseLegalHold — the ONE release command, all scopes
// ---------------------------------------------------------------------------

export type ReleaseCanonicalLegalHoldInput = {
  teamId: string;
  holdId: string;
  actorUserId: string;
  releaseNote: string;
  /**
   * Optimistic concurrency. When supplied and stale, the release is refused
   * with 409 rather than silently overwriting a concurrent decision.
   */
  expectedVersion?: number | null;
  /**
   * Operator confirmation for a hold placed under
   * `requireLegalHoldReleaseApproval`. Enforced HERE (not only at the route)
   * so no scope can bypass it.
   */
  approvalAcknowledged?: boolean;
};

export async function releaseCanonicalLegalHold(
  input: ReleaseCanonicalLegalHoldInput,
  client: PrismaClient = defaultPrisma,
): Promise<CanonicalLegalHoldRow> {
  const note = input.releaseNote.trim();
  if (note.length === 0) throw new LegalHoldError("release_note_required");

  const hold = (await client.evidenceLegalHold.findUnique({
    where: { id: input.holdId },
    select: CANONICAL_SELECT,
  })) as CanonicalLegalHoldRow | null;

  // CROSS-WORKSPACE DENIAL — a hold in another tenant is NOT FOUND, never
  // "forbidden" (which would confirm its existence) and never releasable.
  if (!hold || hold.teamId !== input.teamId) {
    throw new LegalHoldError("hold_not_found");
  }

  // Idempotent: releasing an already-released hold is a no-op, not an error.
  if (hold.status === "RELEASED") return hold;

  if (
    typeof input.expectedVersion === "number" &&
    input.expectedVersion !== hold.version
  ) {
    throw new LegalHoldError("stale_version", {
      expectedVersion: input.expectedVersion,
      currentVersion: hold.version,
    });
  }

  if (
    hold.releaseApprovalRequired &&
    hold.releaseApprovalState !== "APPROVED" &&
    input.approvalAcknowledged !== true
  ) {
    throw new LegalHoldError("release_approval_required");
  }

  const policy = await resolvePolicyAttribution(client, input.teamId);

  // The `version` predicate makes the UPDATE itself the concurrency guard:
  // two concurrent releases cannot both win, even with no expectedVersion.
  const updated = await client.evidenceLegalHold.updateMany({
    where: { id: hold.id, teamId: input.teamId, version: hold.version },
    data: {
      status: "RELEASED",
      releasedAtUtc: new Date(),
      releasedByUserId: input.actorUserId,
      releaseNote: note.slice(0, 4000),
      releaseApprovalState: hold.releaseApprovalRequired
        ? "APPROVED"
        : "NOT_REQUIRED",
      releaseApprovedByUserId: hold.releaseApprovalRequired
        ? (hold.releaseApprovedByUserId ?? input.actorUserId)
        : null,
      releaseApprovedAtUtc: hold.releaseApprovalRequired
        ? (hold.releaseApprovedAtUtc ?? new Date())
        : null,
      releasePolicyVersionAttribution: policy.attribution,
      version: hold.version + 1,
    },
  });
  if (updated.count === 0) {
    throw new LegalHoldError("stale_version", {
      expectedVersion: hold.version,
    });
  }

  const released = (await client.evidenceLegalHold.findUnique({
    where: { id: hold.id },
    select: CANONICAL_SELECT,
  })) as CanonicalLegalHoldRow;

  await fanOutCustodyEvents(client, released, "LEGAL_HOLD_RELEASED", {
    legalHoldId: released.id,
    scope: released.scope,
    releasedByUserId: input.actorUserId,
    // Release note is INTERNAL — captured in the custody chain for reviewers,
    // never surfaced on public verify or any external surface.
    releaseNoteInternal: note.slice(0, 4000),
  });

  // The evidence-hold webhook catalogue has no `governance.legal_hold_released`
  // event; the release fan-out lives on the lifecycle webhook stream, which
  // the scope-generic surface already emitted. Preserved verbatim so existing
  // subscribers keep receiving it for every scope.
  await emitLifecycleHoldWebhook("LEGAL_HOLD_RELEASED", {
    holdId: released.id,
    scope: released.scope,
    scopeTargetId: released.evidenceId ?? released.caseId ?? released.teamId,
  }, { prisma: client, teamId: input.teamId });

  return released;
}

// ---------------------------------------------------------------------------
// ONE audit / custody path
// ---------------------------------------------------------------------------

/**
 * Lifecycle webhook stream emitter, ported verbatim from
 * `lifecycle/legal-hold.service.ts` so converging the command surface does not
 * silently drop an event its subscribers already receive. Fire-and-forget: an
 * audit fan-out failure MUST never break the operational path.
 */
async function emitLifecycleHoldWebhook(
  eventKind: "LEGAL_HOLD_APPLIED" | "LEGAL_HOLD_RELEASED",
  payload: Record<string, unknown>,
  ctx: { prisma?: PrismaClient; teamId: string },
): Promise<void> {
  try {
    const mod = (await import(
      "../packaging/webhooks/webhook-platform.service.js"
    ).catch(() => ({}))) as {
      emitWebhookEvent?: (input: {
        prisma?: PrismaClient;
        teamId: string;
        eventKind: string;
        payload: Record<string, unknown>;
      }) => Promise<unknown> | unknown;
    };
    if (typeof mod.emitWebhookEvent === "function") {
      await mod.emitWebhookEvent({
        prisma: ctx.prisma,
        teamId: ctx.teamId,
        eventKind,
        payload,
      });
    }
  } catch {
    /* audit fan-out failure never breaks the operational path */
  }
}

/**
 * Appends the custody event to every evidence row the hold covers. Best
 * effort by design: the hold itself is already durable, and an audit fan-out
 * failure must never undo or block a preservation control.
 *
 * WORKSPACE scope intentionally does NOT fan out per-evidence — a workspace
 * may hold millions of records, and the control is recorded on the hold row
 * plus the webhook stream.
 */
async function fanOutCustodyEvents(
  client: PrismaClient,
  hold: CanonicalLegalHoldRow,
  eventType: "LEGAL_HOLD_PLACED" | "LEGAL_HOLD_RELEASED",
  payload: Prisma.InputJsonValue,
): Promise<void> {
  try {
    let evidenceIds: string[] = [];
    if (hold.scope === "EVIDENCE" && hold.evidenceId) {
      evidenceIds = [hold.evidenceId];
    } else if (hold.scope === "CASE" && hold.caseId) {
      const linked = await client.caseEvidenceLink.findMany({
        where: { caseId: hold.caseId },
        select: { evidenceId: true },
        take: 1000,
      });
      evidenceIds = linked.map((l) => l.evidenceId);
    }
    await Promise.all(
      evidenceIds.map((evidenceId) =>
        appendCustodyEvent({
          evidenceId,
          eventType:
            eventType === "LEGAL_HOLD_PLACED"
              ? hold.scope === "CASE"
                ? "CASE_LEGAL_HOLD_APPLIED"
                : "LEGAL_HOLD_PLACED"
              : hold.scope === "CASE"
                ? "CASE_LEGAL_HOLD_RELEASED"
                : "LEGAL_HOLD_RELEASED",
          payload,
        }).catch(() => null),
      ),
    );
  } catch {
    /* audit fan-out never breaks the operational path */
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ListCanonicalLegalHoldsInput = {
  teamId: string;
  scope?: CanonicalLegalHoldScope;
  status?: CanonicalLegalHoldStatus;
  evidenceId?: string;
  caseId?: string;
  /** Include HISTORICAL (orphaned, preserved-for-audit) rows. Default: no. */
  includeHistorical?: boolean;
  limit?: number;
};

export async function listCanonicalLegalHolds(
  input: ListCanonicalLegalHoldsInput,
  client: PrismaClient = defaultPrisma,
): Promise<CanonicalLegalHoldRow[]> {
  return (await client.evidenceLegalHold.findMany({
    where: {
      teamId: input.teamId,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.includeHistorical ? {} : { historical: false }),
    },
    orderBy: { placedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    select: CANONICAL_SELECT,
  })) as CanonicalLegalHoldRow[];
}

export async function getCanonicalLegalHold(
  input: { teamId: string; holdId: string },
  client: PrismaClient = defaultPrisma,
): Promise<CanonicalLegalHoldRow | null> {
  const row = (await client.evidenceLegalHold.findUnique({
    where: { id: input.holdId },
    select: CANONICAL_SELECT,
  })) as CanonicalLegalHoldRow | null;
  // Tenant check AFTER the lookup so a foreign hold is indistinguishable
  // from a nonexistent one.
  if (!row || row.teamId !== input.teamId) return null;
  return row;
}

// ---------------------------------------------------------------------------
// LEGACY-SHAPE ADAPTERS
//
// The duplicate public routes (/v1/governance/legal-holds,
// /v1/governance/case-legal-holds, /v1/lifecycle/legal-holds) stay REGISTERED
// and keep their exact response shapes — product surfaces already consume
// them — but they now read through the canonical authority.
//
// Each adapter returns the canonical rows for its scope UNIONed with the
// legacy rows that have not been converted yet, deduplicated on the
// (sourceStore, sourceRowId) provenance key. That union is what makes these
// routes correct BEFORE the backfill migration is applied: a hold visible
// today stays visible, and a hold created through the canonical service is
// visible immediately.
//
// Once the backfill is applied and verified, the legacy halves of these
// adapters return nothing and can be deleted along with the tables.
// ---------------------------------------------------------------------------

export type EvidenceScopedLegalHoldLegacyShape = {
  id: string;
  teamId: string;
  evidenceId: string;
  caseId: string | null;
  title: string;
  reason: string | null;
  status: string;
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
  releaseNote: string | null;
};

/** Backs GET /v1/governance/legal-holds — evidence-scoped rows only. */
export async function listEvidenceScopedLegalHoldsLegacyShape(
  input: { teamId: string; status?: "ACTIVE" | "RELEASED"; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceScopedLegalHoldLegacyShape[]> {
  const rows = await listCanonicalLegalHolds(
    {
      teamId: input.teamId,
      scope: "EVIDENCE",
      status: input.status,
      limit: input.limit,
    },
    client,
  );
  return rows
    .filter((r): r is CanonicalLegalHoldRow & { evidenceId: string } =>
      Boolean(r.evidenceId),
    )
    .map((r) => ({
      id: r.id,
      teamId: r.teamId,
      evidenceId: r.evidenceId,
      caseId: r.caseId,
      title: r.title,
      reason: r.reason,
      status: r.status,
      placedByUserId: r.placedByUserId,
      placedAtUtc: r.placedAtUtc.toISOString(),
      releasedByUserId: r.releasedByUserId,
      releasedAtUtc: r.releasedAtUtc?.toISOString() ?? null,
      releaseNote: r.releaseNote,
    }));
}

export type CaseScopedLegalHoldLegacyShape = {
  id: string;
  teamId: string;
  caseId: string;
  title: string;
  status: string;
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
};

/** Backs GET /v1/governance/case-legal-holds. */
export async function listCaseScopedLegalHoldsLegacyShape(
  input: {
    teamId: string;
    caseId?: string;
    status?: "ACTIVE" | "RELEASED";
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CaseScopedLegalHoldLegacyShape[]> {
  const canonical = await listCanonicalLegalHolds(
    {
      teamId: input.teamId,
      scope: "CASE",
      status: input.status,
      caseId: input.caseId,
      limit: input.limit,
    },
    client,
  );
  const out: CaseScopedLegalHoldLegacyShape[] = canonical
    .filter((r): r is CanonicalLegalHoldRow & { caseId: string } =>
      Boolean(r.caseId),
    )
    .map((r) => ({
      id: r.id,
      teamId: r.teamId,
      caseId: r.caseId,
      title: r.title,
      status: r.status,
      placedByUserId: r.placedByUserId,
      placedAtUtc: r.placedAtUtc.toISOString(),
      releasedByUserId: r.releasedByUserId,
      releasedAtUtc: r.releasedAtUtc?.toISOString() ?? null,
    }));

  // Not-yet-converted legacy rows. Identified by their own id appearing as a
  // canonical `sourceRowId`; anything else is still legacy-only and MUST
  // remain visible, otherwise the surface would under-report preservation.
  // P12.3 — the legacy union merge is retired: every legacy row is now a
  // canonical row that the query above already returned.
  return out;
}

export type LifecycleLegalHoldLegacyShape = {
  id: string;
  teamId: string;
  kind: string;
  scopeTargetId: string | null;
  name: string;
  reason: string;
  state: string;
  createdByUserId: string;
  createdAt: string;
  /** Alias of `createdAt` — the lifecycle UI reads this name. */
  createdAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
  expiresAtUtc: string | null;
  /** Canonical additions, additive on the wire. */
  scope: CanonicalLegalHoldScope;
  version: number;
  releaseApprovalRequired: boolean;
};

function scopeToLegacyKind(
  scope: string,
  organizationId: string | null,
): string {
  if (scope === "EVIDENCE") return "EVIDENCE";
  if (scope === "CASE") return "CASE";
  return organizationId ? "ORGANIZATION" : "WORKSPACE";
}

/** Backs GET /v1/lifecycle/legal-holds — ALL scopes, one surface. */
export async function listLifecycleLegalHoldsLegacyShape(
  input: {
    teamId: string;
    kind?: string;
    state?: string;
    scopeTargetId?: string;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<LifecycleLegalHoldLegacyShape[]> {
  const canonical = await listCanonicalLegalHolds(
    { teamId: input.teamId, limit: input.limit ?? 500 },
    client,
  );
  const out: LifecycleLegalHoldLegacyShape[] = canonical
    .filter((r) => {
      if (input.state && r.status !== input.state) return false;
      if (
        input.kind &&
        scopeToLegacyKind(r.scope, r.organizationId) !== input.kind
      ) {
        return false;
      }
      if (
        input.scopeTargetId &&
        (r.evidenceId ?? r.caseId ?? r.teamId) !== input.scopeTargetId
      ) {
        return false;
      }
      return true;
    })
    .map((r) => ({
      id: r.id,
      teamId: r.teamId,
      kind: scopeToLegacyKind(r.scope, r.organizationId),
      scopeTargetId: r.evidenceId ?? r.caseId ?? r.teamId,
      name: r.title,
      reason: r.reason ?? "",
      state: r.status,
      createdByUserId: r.placedByUserId,
      createdAt: r.placedAtUtc.toISOString(),
      createdAtUtc: r.placedAtUtc.toISOString(),
      releasedByUserId: r.releasedByUserId,
      releasedAtUtc: r.releasedAtUtc?.toISOString() ?? null,
      expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
      scope: r.scope as CanonicalLegalHoldScope,
      version: r.version,
      releaseApprovalRequired: r.releaseApprovalRequired,
    }));

  // P12.3 — the legacy union merge is retired: every legacy row is now a
  // canonical row that the query above already returned.
  return out;
}

/**
 * Release adapter used by the duplicate routes. A hold id may still address a
 * legacy row that has not been converted yet, so the canonical release is
 * tried first and the legacy store is used as the fallback. Both paths keep
 * the release note and the tenant check; neither can release a hold in
 * another workspace.
 */
export async function releaseLegalHoldAnyStore(
  input: {
    teamId: string;
    holdId: string;
    actorUserId: string;
    releaseNote: string;
    expectedVersion?: number | null;
    approvalAcknowledged?: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ store: "CANONICAL" | "CASE_LEGAL_HOLD" | "LIFECYCLE_LEGAL_HOLD" }> {
  const canonical = await getCanonicalLegalHold(
    { teamId: input.teamId, holdId: input.holdId },
    client,
  );
  if (canonical) {
    await releaseCanonicalLegalHold(input, client);
    return { store: "CANONICAL" };
  }

  // P12.3 — the legacy release fallbacks are retired. Every hold now lives
  // in the canonical table, so a hold id that does not resolve there does not
  // exist. Reaching for a dropped table would only turn "not found" into a
  // confusing relation error.
  throw new LegalHoldError("hold_not_found");
}

// ===========================================================================
// PHASE 12 POINT 3 — CANONICAL-ONLY COUNT/LIST HELPERS.
//
// Before this phase ~33 runtime sites queried the LEGACY delegates
// (`prisma.caseLegalHold`, `prisma.legalHold`) directly. Every one of them
// throws the moment 20271108000000 drops those tables, and every one of them
// was blind to holds placed through the canonical service. These helpers are
// the ONE replacement: they answer the same questions against
// `evidence_legal_holds` — the single authority — so a call site needs no
// knowledge of which store a hold originally came from.
//
// Scope mapping (see 20271107000000_legal_hold_backfill):
//   legacy case_legal_holds row  → scope='CASE',      case_id set
//   legacy legal_holds row       → scope='WORKSPACE'  (kind WORKSPACE/ORG)
//                                  scope='EVIDENCE'   (kind EVIDENCE)
//                                  scope='CASE'       (kind CASE)
// ===========================================================================

/** ACTIVE case-scoped holds covering ANY of the given cases. */
export async function countActiveCaseHolds(
  input: { teamId?: string; caseIds?: string[]; caseId?: string },
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const caseIds = input.caseId
    ? [input.caseId]
    : input.caseIds && input.caseIds.length > 0
      ? input.caseIds
      : null;
  return client.evidenceLegalHold.count({
    where: {
      scope: "CASE",
      status: "ACTIVE",
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(caseIds ? { caseId: { in: caseIds } } : {}),
    },
  });
}

/** Case-scoped holds in the legacy projection shape, canonical-sourced. */
export async function listCaseHolds(
  input: {
    teamId?: string;
    teamIds?: string[];
    caseIds?: string[];
    caseId?: string;
    status?: "ACTIVE" | "RELEASED";
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<
  Array<{
    id: string;
    teamId: string;
    caseId: string | null;
    title: string;
    reason: string | null;
    status: string;
    placedByUserId: string;
    placedAtUtc: Date;
    releasedByUserId: string | null;
    releasedAtUtc: Date | null;
    releaseNote: string | null;
  }>
> {
  const caseIds = input.caseId
    ? [input.caseId]
    : input.caseIds && input.caseIds.length > 0
      ? input.caseIds
      : null;
  const rows = await client.evidenceLegalHold.findMany({
    where: {
      scope: "CASE",
      ...(input.status ? { status: input.status } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamIds && input.teamIds.length > 0
        ? { teamId: { in: input.teamIds } }
        : {}),
      ...(caseIds ? { caseId: { in: caseIds } } : {}),
    },
    orderBy: { placedAtUtc: "desc" },
    ...(input.limit ? { take: input.limit } : {}),
  });
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    caseId: r.caseId,
    title: r.title,
    reason: r.reason,
    status: r.status,
    placedByUserId: r.placedByUserId,
    placedAtUtc: r.placedAtUtc,
    releasedByUserId: r.releasedByUserId,
    releasedAtUtc: r.releasedAtUtc,
    releaseNote: r.releaseNote,
  }));
}

/**
 * Lifecycle-store holds by state, canonical-sourced. `state` uses the legacy
 * vocabulary (ACTIVE / RELEASED / EXPIRED) which the canonical status enum
 * carries verbatim.
 */
export async function countLifecycleHolds(
  input: { teamId?: string; teamIds?: string[]; state: "ACTIVE" | "RELEASED" | "EXPIRED" },
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  return client.evidenceLegalHold.count({
    where: {
      status: input.state,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamIds && input.teamIds.length > 0
        ? { teamId: { in: input.teamIds } }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// PHASE 12 POINT 3 — absorbed from `governance/case-legal-hold.service.ts`.
//
// That module was the last surviving fragment of the case-only legal-hold
// authority. Its writers were already deleted; these two symbols were all that
// remained live, and they held no case-only logic — the error type is a plain
// bounded code carrier, and the predicate was already a thin delegation to the
// ONE effective-hold evaluator. Keeping a separately-named service alive for
// two symbols would have implied a second authority still exists, and its
// `CaseLegalHold` Prisma type import would have kept the dropped model alive in
// the schema. Both now live with the authority that owns them.
// ---------------------------------------------------------------------------

/**
 * Bounded failure codes for CASE-scoped legal-hold operations. Retained
 * verbatim so the `/v1/governance/case-legal-holds` response contract does not
 * change while that compatibility route exists.
 */
export class CaseLegalHoldError extends Error {
  constructor(
    public readonly code:
      | "case_not_in_workspace"
      | "hold_not_found"
      | "release_note_required"
      | "release_approval_required",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "CaseLegalHoldError";
  }
}

/**
 * True when the evidence is preserved by ANY active hold in the canonical
 * store — evidence-direct, CASE-scoped on ANY linked case (linked via the
 * canonical `CaseEvidenceLink` table), or WORKSPACE-scoped.
 *
 * A thin delegation to THE effective-hold evaluator; it performs no store
 * selection of its own.
 */
export async function isEvidenceUnderAnyLegalHold(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const ev = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, teamId: true },
  });
  if (!ev) return false;
  const result = await evaluateEffectiveLegalHold(client, {
    teamId: ev.teamId ?? null,
    evidenceId,
  });
  return result.held;
}
