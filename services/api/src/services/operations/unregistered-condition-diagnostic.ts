/**
 * THE BOUNDED DIAGNOSTIC FOR A CONDITION NOBODY REGISTERED.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIAGNOSTIC AND NOT AN ERROR
 * ---------------------------------------------------------------------------
 * An unregistered source is a DEVELOPMENT fault — somebody shipped an emitter
 * without registering its lifecycle contract — and the emitter-totality gate
 * exists to stop it reaching production at all. If one arrives anyway, two
 * things must both be true:
 *
 *   * the condition still fails closed, so nobody can declare it resolved on
 *     the strength of the system not knowing what it is;
 *   * the gap is VISIBLE to the people who can fix it, rather than sitting in
 *     a tenant's queue as a row that quietly cannot be actioned.
 *
 * Raising would satisfy neither: it would lose the observed condition, which
 * is the failure this whole programme has been correcting.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MAY CONTAIN, AND WHAT IT MAY NOT
 * ---------------------------------------------------------------------------
 * Three fields, all safe to put in a platform log:
 *
 *   * the source classification — the id the writer passed, or its absence;
 *   * the writer family, when the caller knows it;
 *   * a workspace-safe correlation id — the workspace's OWN id, which the
 *     operator of that workspace already has.
 *
 * Never: the fingerprint (it embeds record ids and event types), the title or
 * summary (they embed evidence titles), SQL, a provider name, a hostname, a
 * queue name, or any infrastructure identifier. Nothing here reaches a
 * browser under any circumstances — this is a server log line, and the tenant
 * response for the same condition is the ordinary bounded projection.
 */

import { warn as logWarn } from "../../utils/logger.js";
import { bump } from "../ops/metrics.service.js";
import { UNREGISTERED_CONDITION_DIAGNOSTIC } from "@proovra/shared-runtime";

/** Which family of writer produced it. Bounded; never a file path from input. */
export type UnregisteredWriterFamily =
  | "api.recordIncident"
  | "api.projection"
  | "api.manualResolution"
  | "worker.recordWorkerIncident";

export type UnregisteredConditionReport = {
  /** The id the writer passed, or null when the row carries none. */
  sourceId: string | null;
  /** The incident category. A bounded enum, safe to log. */
  category?: string | null;
  /** The workspace's own id. Safe: its operators already have it. */
  teamId?: string | null;
  writer: UnregisteredWriterFamily;
};

/**
 * Record that a condition resolved to no registered source.
 *
 * Best-effort by construction: a diagnostic that could throw would be a
 * logging path able to break the observation it is describing.
 */
export function reportUnregisteredConditionSource(
  report: UnregisteredConditionReport,
): void {
  try {
    bump("operational_incident_unregistered_source");
    logWarn("operations.unregistered_condition_source", {
      diagnostic: UNREGISTERED_CONDITION_DIAGNOSTIC,
      // Bounded: an id long enough to be a payload is truncated rather than
      // logged whole, because the one thing an unregistered id is NOT is
      // trusted input.
      sourceId: report.sourceId ? report.sourceId.slice(0, 120) : null,
      category: report.category ?? null,
      workspaceId: report.teamId ?? null,
      writer: report.writer,
    });
  } catch {
    /* a diagnostic must never break the path it is describing */
  }
}

/**
 * A condition was written under a source its signal does not belong to
 * (2026-10-14): normalized to its own source, or refused. Bounded fields only
 * — the declared and decided source ids, the workspace and the writer; never
 * the fingerprint, title, payload or any record identifier.
 */
export function reportConditionSourceDecision(report: {
  outcome: "NORMALIZED" | "REFUSED";
  declaredSourceId: string;
  decidedSourceId: string | null;
  reason: string | null;
  teamId: string | null;
  writer: string;
}): void {
  try {
    bump(report.outcome === "NORMALIZED" ? "operations_condition_source_normalized" : "operations_condition_source_refused");
    logWarn("operations.condition_source_decision", {
      outcome: report.outcome,
      declaredSourceId: report.declaredSourceId.slice(0, 120),
      decidedSourceId: report.decidedSourceId ? report.decidedSourceId.slice(0, 120) : null,
      reason: report.reason,
      workspaceId: report.teamId,
      writer: report.writer,
    });
  } catch {
    /* a diagnostic must never break the path it is describing */
  }
}
