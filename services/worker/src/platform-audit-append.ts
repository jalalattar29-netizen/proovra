import type { Prisma } from "@prisma/client";
import { appendAdminAuditChainRowTx } from "@proovra/shared-runtime";
import { prisma } from "./db.js";

/**
 * PHASE 12 POINT 3 — this appender once wrote `chainVersion: 2` and never bound
 * tenant scope, because the worker carried an older fork of the chain library
 * with no V3 variant. Since 2026-09-29 (ET-CUS-05) there is no fork to drift:
 * the library and the append itself live once, in @proovra/shared-runtime
 * (audit/admin-audit-chain), and this writer calls it.
 *
 * `organizationId` / `workspaceId` are supplied by the caller from the
 * PERSISTED row it is auditing (evidence.organizationId / evidence.teamId) —
 * never inferred from an actor or ambient context. When a worker action
 * genuinely has no tenant subject the columns stay NULL and are hashed as the
 * explicit null-scope sentinel, which is an honest "unscoped", not a guess.
 */
/**
 * PHASE 5 §3 — ONE OUTCOME VOCABULARY, NOT TWO.
 *
 * This writer accepted `success | failure | blocked` while the API's canonical
 * facade wrote `success | denied | error` into the SAME column. Two languages
 * for one field is not a cosmetic inconsistency: an operator filtering the
 * Admin audit for `outcome=error` saw no worker failures at all, because every
 * worker failure was spelled `failure`. The rows were there and the filter was
 * right; the vocabulary was wrong.
 *
 * The canonical spelling wins — it is what the 232 API call sites write and
 * what the read filters send. The worker's two divergent spellings are still
 * ACCEPTED at this boundary and normalised here, so no caller breaks and no
 * caller can reintroduce the split by accident.
 */
const CANONICAL_OUTCOME: Record<string, string> = {
  success: "success",
  completed: "completed",
  queued: "queued",
  no_op: "no_op",
  partial: "partial",
  // The two divergent worker spellings, mapped to the canonical meanings.
  failure: "error",
  error: "error",
  blocked: "denied",
  denied: "denied",
};

export async function appendWorkerAuditLog(params: {
  userId: string | null;
  action: string;
  category?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  source?: string | null;
  outcome?:
    | "success"
    | "failure"
    | "blocked"
    | "error"
    | "denied"
    | "queued"
    | "completed"
    | "no_op"
    | "partial"
    | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** Authoritative persisted tenant scope of the audited row. */
  organizationId?: string | null;
  workspaceId?: string | null;
  /**
   * PHASE 5 §4 — the service identity that acted, e.g. `worker:report`.
   *
   * Automated work must not read as though a person did it. Defaults to the
   * generic worker identity rather than being left blank, because a blank
   * actor is the thing an operator cannot interpret.
   */
  serviceActor?: string | null;
  actorDisplay?: string | null;
  previousState?: string | null;
  requestedState?: string | null;
  resultingState?: string | null;
  targetDisplay?: string | null;
  reasonCode?: string | null;
}): Promise<void> {
  const action = params.action.trim().slice(0, 128);
  if (!action) return;

  const category = params.category?.trim().slice(0, 64) || null;
  const severity = params.severity ?? "info";
  const source = params.source?.trim().slice(0, 64) || "worker";
  const outcome = CANONICAL_OUTCOME[params.outcome ?? "success"] ?? "success";
  // PHASE 5 §4 — a worker action is a WORKER action. The row used to be
  // indistinguishable from an unattributed one: `userId` null, no actor type,
  // and a literal "proovra-worker" stuffed into the user-agent column, which
  // is a field for describing a browser and not a place to hide an identity.
  const serviceActor = params.serviceActor?.trim().slice(0, 64) || "worker:generic";
  const actorType = params.userId ? "HUMAN" : "WORKER";
  const actorDisplay =
    params.actorDisplay?.trim().slice(0, 160) ||
    (params.userId ? null : "Automated worker");
  const resourceType = params.resourceType?.trim().slice(0, 64) || null;
  const resourceId = params.resourceId?.trim().slice(0, 128) || null;
  const requestId = params.requestId?.trim().slice(0, 64) || null;
  const metadata = (params.metadata ?? {}) as Prisma.InputJsonValue;
  const organizationId = params.organizationId ?? null;
  const workspaceId = params.workspaceId ?? null;

  const actorAuthority = params.userId ? null : serviceActor;
  // THE ONE APPEND (shared-runtime audit/admin-audit-chain): lock, head,
  // strictly increasing createdAt (ET-CUS-05), V4 hash, insert.
  await prisma.$transaction((tx) =>
    appendAdminAuditChainRowTx(tx, {
      userId: params.userId ?? null,
      isPublic: false,
      action,
      category,
      severity,
      source,
      outcome,
      resourceType,
      resourceId,
      requestId,
      organizationId,
      workspaceId,
      actorType,
      actorDisplay,
      actorAuthority,
      targetDisplay: params.targetDisplay?.trim().slice(0, 160) || null,
      previousState: params.previousState?.trim().slice(0, 64) || null,
      requestedState: params.requestedState?.trim().slice(0, 64) || null,
      resultingState: params.resultingState?.trim().slice(0, 64) || null,
      reasonCode: params.reasonCode?.trim().slice(0, 64) || null,
      eventVersion: 2,
      metadata,
      ipAddress: null,
      // The worker has no browser. It used to write the literal string
      // "proovra-worker" here, which made a machine action look like a client
      // fingerprint; the identity lives in actorType/actorAuthority instead.
      userAgent: null,
    }),
  );
}
