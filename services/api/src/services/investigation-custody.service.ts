/**
 * Wave 3 Phase 7B — Investigation mutation custody emitter.
 *
 * The canonical CustodyEvent model is evidence-anchored (CustodyEvent
 * has a non-null `evidenceId` FK to Evidence). The 8 Wave 3 mutation
 * sites either operate on a specific evidence anchor (duplicate
 * decision, manual relationship between two evidence nodes) or are
 * workspace-scoped (reconcile, MI refresh, exports).
 *
 * To preserve a truthful custody chain for both cases:
 *
 *   * For mutations with an explicit evidence anchor (e.g. one or both
 *     endpoints of an investigation graph edge resolve to EVIDENCE
 *     nodes), the custody entry is appended on each anchor evidence.
 *
 *   * For workspace-scoped mutations (reconcile / MI refresh /
 *     exports), the custody entry is appended on the most recently
 *     updated evidence in the workspace as a representative anchor.
 *     This keeps the cross-workspace custody chain non-empty and
 *     auditable while honoring the FK constraint on CustodyEvent.
 *     When the workspace has no evidence rows, the emit is a clean
 *     no-op (the appendPlatformAuditLog row remains as the chain of
 *     custody on the audit channel).
 *
 * Hard contracts:
 *   * Best-effort — every call site uses the `noteAndSwallow` pattern
 *     so a custody-append failure NEVER fails the surrounding mutation.
 *     The pattern matches the existing
 *     `services/custody-events-observability.ts` swallow.
 *   * Bounded payload — payload size is capped at ~200 bytes
 *     serialized, no PII, no large blobs, no req.body dumps.
 *   * Called AFTER the DB write succeeds (the caller decides when).
 *
 * The 8 custody event types this module emits:
 *
 *   DUPLICATE_DECISION_RECORDED
 *   MANUAL_RELATIONSHIP_CREATED
 *   MANUAL_RELATIONSHIP_RETRACTED
 *   GRAPH_RECONCILE_REQUESTED
 *   MEDIA_INTELLIGENCE_REFRESH_REQUESTED
 *   INVESTIGATION_GRAPH_EXPORTED
 *   INVESTIGATION_TIMELINE_EXPORTED
 *   INVESTIGATION_DUPLICATES_EXPORTED
 */

import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { appendCustodyEvent } from "./custody-events.service.js";
import { swallowCustodyAppendError } from "./custody-events-observability.js";

const MAX_PAYLOAD_BYTES = 200;

type CustodyAnchor = {
  evidenceId: string;
};

/**
 * Resolve a representative evidence anchor for a workspace-scoped
 * custody emit. Picks the most recently updated non-deleted evidence
 * in the team; returns null when the workspace has no evidence.
 */
async function resolveWorkspaceAnchor(
  teamId: string,
): Promise<CustodyAnchor | null> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "id"
         FROM "evidence"
         WHERE "team_id" = $1 AND "deleted_at" IS NULL
         ORDER BY "created_at" DESC
         LIMIT 1`,
      teamId,
    )) as Array<{ id: string }>;
    const row = rows[0];
    if (!row?.id) return null;
    return { evidenceId: row.id };
  } catch {
    return null;
  }
}

/**
 * Resolve the evidence anchor(s) for a graph edge. The edge has two
 * endpoints (source_node_id / target_node_id) which may reference
 * EVIDENCE nodes (the most common shape for duplicate-class +
 * manual edges) or other graph node kinds. We return the set of
 * distinct evidence ids referenced by the two endpoints.
 */
async function resolveEdgeEvidenceAnchors(
  teamId: string,
  edgeId: string,
): Promise<CustodyAnchor[]> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT n."external_id" AS evidence_id
         FROM "investigation_graph_edges" e
         JOIN "investigation_graph_nodes" n
           ON (n."id" = e."source_node_id" OR n."id" = e."target_node_id")
         WHERE e."id" = $1
           AND e."team_id" = $2
           AND n."team_id" = $2
           AND n."node_kind"::text = 'EVIDENCE'
         LIMIT 4`,
      edgeId,
      teamId,
    )) as Array<{ evidence_id: string }>;
    return rows
      .filter((r) => typeof r.evidence_id === "string" && r.evidence_id.length > 0)
      .map((r) => ({ evidenceId: r.evidence_id }));
  } catch {
    return [];
  }
}

/**
 * Bounded payload guard. Throws (synchronously) when the serialized
 * payload exceeds the 200-byte cap so calls with too-large details
 * surface in tests.
 */
function assertBoundedPayload(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `investigation_custody_payload_too_large: ${serialized.length} > ${MAX_PAYLOAD_BYTES}`,
    );
  }
}

export type InvestigationCustodyParams = {
  teamId: string;
  actorUserId: string;
  eventType: prismaPkg.CustodyEventType;
  /** Bounded payload (≤ 200 bytes serialized). No PII, no blobs. */
  payload: Record<string, unknown>;
  /**
   * Optional explicit evidence anchors. When supplied, the emit
   * appends to each of these. When omitted, the helper resolves a
   * workspace anchor as the chain entry point.
   */
  anchorEvidenceIds?: string[];
  /** Optional graph edge id — anchors are resolved via the edge's endpoints. */
  edgeId?: string;
  /** Optional source surface string for observability swallow. */
  surface: string;
};

/**
 * Append the investigation custody entry. Best-effort — swallows
 * failures via `swallowCustodyAppendError`. Returns the number of
 * custody entries actually appended (0 when no anchor resolved).
 */
export async function appendInvestigationCustody(
  params: InvestigationCustodyParams,
): Promise<number> {
  assertBoundedPayload(params.payload);

  let anchors: CustodyAnchor[] = [];

  if (params.anchorEvidenceIds && params.anchorEvidenceIds.length > 0) {
    anchors = params.anchorEvidenceIds.map((id) => ({ evidenceId: id }));
  } else if (params.edgeId) {
    anchors = await resolveEdgeEvidenceAnchors(params.teamId, params.edgeId);
    if (anchors.length === 0) {
      const fallback = await resolveWorkspaceAnchor(params.teamId);
      if (fallback) anchors = [fallback];
    }
  } else {
    const fallback = await resolveWorkspaceAnchor(params.teamId);
    if (fallback) anchors = [fallback];
  }

  if (anchors.length === 0) return 0;

  // Attribute via payload (custody event payload is a JSON column).
  // The user attribution is implicit via the audit chain emit beside
  // this call; we embed actorUserId in the bounded payload for
  // cross-channel correlation.
  const attributedPayload = { ...params.payload, actorUserId: params.actorUserId };
  assertBoundedPayload(attributedPayload);

  let appended = 0;
  for (const anchor of anchors) {
    try {
      await appendCustodyEvent({
        evidenceId: anchor.evidenceId,
        eventType: params.eventType,
        payload: attributedPayload as unknown as prismaPkg.Prisma.InputJsonValue,
      });
      appended += 1;
    } catch (err) {
      // Swallow per the canonical pattern — never block the surrounding
      // operator action. The structured warn log + counter bump + Sentry
      // capture make the failure observable.
      void swallowCustodyAppendError(err, {
        surface: params.surface,
        evidenceId: anchor.evidenceId,
        custodyEventType: params.eventType,
      });
    }
  }
  return appended;
}
