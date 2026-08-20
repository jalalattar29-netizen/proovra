/**
 * THE server-side loader for evidence analysis snapshots.
 *
 * One query shape, one snapshot type, one revision computation — used by every
 * Copilot route and by every projection that lists selectable evidence. The
 * point is that the fields a revision covers and the fields a route reads
 * cannot diverge: they are the same `select`.
 *
 * IMMUTABILITY IS THE TOCTOU STRATEGY.
 *
 * A snapshot is frozen the moment it is read, and it is the ONLY thing that
 * flows onward: eligibility is judged on it, the revision is computed from it,
 * the budget key is derived from it, and the provider's prompt is built from
 * it. There is no second read that could quietly disagree with the first.
 *
 * That leaves exactly one window — between accepting a revision and actually
 * spending on the provider, another writer could commit. `findDriftedSnapshot`
 * closes it by re-reading and recomputing immediately before the spend; if
 * anything moved, the reservation is released and the operator is told to
 * refresh. Cheap, because it is one indexed read against ids already known.
 */
import {
  buildEvidenceAnalysisRevision,
  type EvidenceAnalysisContext,
  type EvidenceAnalysisFacts,
} from "@proovra/shared-runtime";

import { prisma } from "../../db.js";

/**
 * The canonical `select`.
 *
 * Every field here feeds either the revision, eligibility, or the prompt — and
 * each of those reads THIS row rather than issuing its own query. Adding a
 * field to a Copilot prompt without adding it here is the failure this shape
 * exists to prevent, and `evidence-analysis-revision.contract.test.ts` fails
 * when the two drift.
 */
export const EVIDENCE_ANALYSIS_SELECT = {
  id: true,
  teamId: true,
  title: true,
  type: true,
  mimeType: true,
  status: true,
  verificationStatus: true,
  captureMethod: true,
  tsaStatus: true,
  otsStatus: true,
  createdAt: true,
  lifecycleState: true,
  deletedAt: true,
  archivedAt: true,
  latestReportVersion: true,
  verificationPackageVersion: true,
  // `reports` and `verificationPackages` are counted, not inferred from a
  // version column. The lifecycle contract is explicit that a version is a
  // snapshot-only material and never a readiness proxy — an artifact is
  // "ready" when the artifact EXISTS.
  _count: {
    select: {
      parts: true,
      custodyEvents: true,
      caseLinks: true,
      reports: true,
      verificationPackages: true,
    },
  },
  caseLinks: { select: { caseId: true } },
} as const;

/** The row shape `EVIDENCE_ANALYSIS_SELECT` produces. */
export type EvidenceAnalysisRow = {
  id: string;
  teamId: string | null;
  title: string | null;
  type: string | null;
  mimeType: string | null;
  status: string | null;
  verificationStatus: string | null;
  captureMethod: string | null;
  tsaStatus: string | null;
  otsStatus: string | null;
  createdAt: Date | null;
  lifecycleState: string | null;
  deletedAt: Date | null;
  archivedAt: Date | null;
  latestReportVersion: number | null;
  verificationPackageVersion: number | null;
  _count: {
    parts: number;
    custodyEvents: number;
    caseLinks: number;
    reports: number;
    verificationPackages: number;
  };
  caseLinks: Array<{ caseId: string }>;
};

/**
 * One record, as it was at the instant it was read, plus its revision.
 *
 * Frozen. Everything downstream reads this object rather than the database, so
 * "the snapshot whose revision was accepted" and "the snapshot the model was
 * shown" are the same object by construction, not by discipline.
 */
export type EvidenceAnalysisSnapshot = Readonly<{
  row: Readonly<EvidenceAnalysisRow>;
  /** `ear1_…` — the opaque authority, for this record in THIS context. */
  revision: string;
  /** Whether this record is linked to the operation's scope, where meaningful. */
  linkedToScope: boolean | null;
}>;

/** Translate a persisted row into the facts a revision is derived from. */
export function evidenceAnalysisFacts(row: EvidenceAnalysisRow): EvidenceAnalysisFacts {
  return {
    id: row.id,
    teamId: row.teamId,
    title: row.title,
    type: row.type,
    mimeType: row.mimeType,
    status: row.status,
    verificationStatus: row.verificationStatus,
    captureMethod: row.captureMethod,
    tsaStatus: row.tsaStatus,
    otsStatus: row.otsStatus,
    createdAtUtc: row.createdAt,
    partCount: row._count.parts,
    custodyEventCount: row._count.custodyEvents,
    caseLinkCount: row._count.caseLinks,
    latestReportVersion: row.latestReportVersion,
    verificationPackageVersion: row.verificationPackageVersion,
    lifecycleState: row.lifecycleState,
    deletedAt: row.deletedAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Which operation a snapshot is being taken for.
 *
 * `caseId` is what makes a CASE snapshot context-bound: a record unlinked from
 * that case yields a different revision even though nothing about the evidence
 * itself changed.
 */
export type AnalysisScope =
  | { scope: "case"; scopeId: string }
  | { scope: "evidence"; scopeId: string | null }
  | { scope: "reviewer"; scopeId: string };

/** The context a revision is computed under, for one row. */
function contextFor(row: EvidenceAnalysisRow, scope: AnalysisScope): EvidenceAnalysisContext {
  // Only the CASE surface has a scope a record can be linked to. Elsewhere the
  // answer is `null` — "not a concept here" — which is deliberately different
  // from `false` and hashes differently.
  const linkedToScope =
    scope.scope === "case" ? row.caseLinks.some((l) => l.caseId === scope.scopeId) : null;
  return { scope: scope.scope, scopeId: scope.scopeId, linkedToScope };
}

/** Compute one record's revision, in one context. */
export function evidenceAnalysisRevisionFor(
  row: EvidenceAnalysisRow,
  scope: AnalysisScope,
): string {
  return buildEvidenceAnalysisRevision(evidenceAnalysisFacts(row), contextFor(row, scope));
}

/** Freeze a row into the snapshot everything downstream reads. */
export function toSnapshot(
  row: EvidenceAnalysisRow,
  scope: AnalysisScope,
): EvidenceAnalysisSnapshot {
  const ctx = contextFor(row, scope);
  return Object.freeze({
    row: Object.freeze(row),
    revision: buildEvidenceAnalysisRevision(evidenceAnalysisFacts(row), ctx),
    linkedToScope: ctx.linkedToScope,
  });
}

/**
 * Load every selected record, tenant-scoped, as frozen snapshots.
 *
 * TENANCY IS ENFORCED IN THE QUERY, not after it. A record from another
 * workspace is simply not returned, so the caller sees a count mismatch and
 * answers without confirming that the id exists — the non-enumerating response
 * the product uses everywhere.
 *
 * Trashed records (`deletedAt`) ARE returned. They are then refused by
 * eligibility with a reason, which is a better answer than "does not exist" for
 * a record the operator can still see in their own trash.
 */
export async function loadEvidenceAnalysisSnapshots(input: {
  ids: ReadonlyArray<string>;
  teamId: string;
  scope: AnalysisScope;
}): Promise<EvidenceAnalysisSnapshot[]> {
  const rows = (await prisma.evidence.findMany({
    where: { id: { in: [...input.ids] }, teamId: input.teamId },
    select: EVIDENCE_ANALYSIS_SELECT,
  })) as unknown as EvidenceAnalysisRow[];
  return rows.map((r) => toSnapshot(r, input.scope));
}

/**
 * Has anything moved since these snapshots were taken?
 *
 * THE TOCTOU CLOSE. Called immediately before the provider spend, after the
 * budget reservation, because that is the only window the frozen snapshot does
 * not already cover. It re-reads the same ids and recomputes the same
 * revisions; a mismatch means another writer committed in between.
 *
 * Returns the id of the first record that moved, or `null` when nothing did.
 * The id is safe to return: the caller has already proved the actor may see
 * every record in this set.
 */
export async function findDriftedSnapshot(input: {
  snapshots: ReadonlyArray<EvidenceAnalysisSnapshot>;
  teamId: string;
  scope: AnalysisScope;
}): Promise<string | null> {
  if (input.snapshots.length === 0) return null;
  const fresh = await loadEvidenceAnalysisSnapshots({
    ids: input.snapshots.map((s) => s.row.id),
    teamId: input.teamId,
    scope: input.scope,
  });
  const byId = new Map(fresh.map((s) => [s.row.id, s.revision]));
  for (const s of input.snapshots) {
    // A record that vanished between the two reads counts as drift, not as
    // "unchanged": it is no longer analyzable and must not be spent on.
    if (byId.get(s.row.id) !== s.revision) return s.row.id;
  }
  return null;
}
