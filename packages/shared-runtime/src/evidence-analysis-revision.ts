/**
 * THE evidence analysis revision — one server-owned answer to one question:
 *
 *   "Has any server-authoritative input that can affect this Copilot operation
 *    changed since the operator selected the evidence?"
 *
 * WHY `verificationPackageVersion` COULD NOT BE THAT ANSWER
 * ---------------------------------------------------------------------------
 * It was the answer, on every AI surface, and it is a package counter. The
 * fields a Copilot actually sees are fixed by the two context allowlists in
 * `ai-context-resolver.service.ts`, and their union is:
 *
 *   title · type · mimeType · status · verificationStatus · captureMethod ·
 *   caseLinked · itemCount · createdAtUtc · reportReady/reportVersion ·
 *   packageReady/packageVersion · tsaStatus · otsStatus · custodyEventCount
 *
 * Exactly ONE of those moves `verificationPackageVersion`. Renaming a record,
 * correcting its MIME type, completing its integrity check, unlinking it from
 * the case, publishing a report, adding a part, archiving it, or sending it to
 * trash all changed what the model would be told while the concurrency check
 * reported no change at all. A guard that misses thirteen of fourteen inputs is
 * not a concurrency authority; it is a package-version comparison that had been
 * asked to stand in for one.
 *
 * WHY THIS IS DERIVED RATHER THAN A COLUMN
 * ---------------------------------------------------------------------------
 * The alternative — a monotonic `recordVersion` incremented by every writer —
 * is only as good as the completeness of that migration, and the repository has
 * no such column today. Two facts settle it:
 *
 *   - `Evidence.updatedAt` is a Prisma `@updatedAt` timestamp on the evidence
 *     ROW. Linking or unlinking a case writes `CaseEvidenceLink`, a different
 *     table, and never touches it. A record's relationship to a case can change
 *     completely while `updatedAt` stands still.
 *   - `@updatedAt` is applied by the Prisma client, so any raw-SQL, import or
 *     admin path bypasses it silently.
 *
 * A derived digest has neither problem: it cannot be bypassed, because it is
 * not written. It is recomputed from persisted state every time it is needed,
 * so a writer that forgets to bump something does not exist as a failure mode.
 *
 * THE TOKEN
 * ---------------------------------------------------------------------------
 *     ear1_<43-character base64url SHA-256>
 *
 * Opaque, versioned by its prefix, and the FULL digest — a truncated one stops
 * being able to distinguish two states, which is the only thing it is for.
 *
 * It carries no metadata: it is a digest of the snapshot, not an encoding of
 * it, so projecting it to an authorized client discloses nothing about the
 * record. It is NOT an authorization credential — holding a revision proves
 * only that a client once saw a record, and every route still authorizes the
 * actor against the record independently, before this is even consulted.
 *
 * The client may CARRY it. The client may never compute it, which is why this
 * module lives in `@proovra/shared-runtime` — a Prisma-side package the browser
 * bundle cannot import — rather than in `@proovra/shared`.
 */
import { sha256Base64Url } from "@proovra/shared";

/** The schema version this module produces. Changing the shape changes this. */
export const EVIDENCE_ANALYSIS_REVISION_SCHEMA = "ear1";

/**
 * The persisted evidence facts a revision is derived from.
 *
 * Every field below is here because it reaches a Copilot prompt, decides
 * eligibility, or points at an artifact the output may cite. Nothing is here
 * because it happens to be mutable.
 */
export type EvidenceAnalysisFacts = {
  // --- identity and tenancy -------------------------------------------------
  /** Binds the token to ONE record, so a revision cannot be replayed onto another. */
  id: string;
  /** Binds it to ONE tenant. A re-tenanted record is a different subject. */
  teamId: string | null;

  // --- allowlisted prompt fields -------------------------------------------
  /** Prompt field `title` on every surface. */
  title: string | null;
  /** Prompt field `type`; also shapes what the copilot is allowed to say. */
  type: string | null;
  /** Prompt field `mimeType`. A MIME correction changes the analysis. */
  mimeType: string | null;
  /** Prompt field `status` AND the primary eligibility input. */
  status: string | null;
  /** Prompt field `verificationStatus`; the integrity narrative. */
  verificationStatus: string | null;
  /** Prompt field `captureMethod` (Evidence Copilot). */
  captureMethod: string | null;
  /** Prompt field `tsaStatus`; the timestamping narrative. */
  tsaStatus: string | null;
  /** Prompt field `otsStatus`. */
  otsStatus: string | null;
  /** Prompt field `createdAtUtc`. */
  createdAtUtc: Date | string | null;
  /** Prompt field `itemCount` — parts appearing or disappearing changes it. */
  partCount: number;
  /** Prompt field `custodyEventCount`. */
  custodyEventCount: number;
  /**
   * How many cases this record is linked to.
   *
   * The prompt shows the boolean `caseLinked`, but the COUNT is the honest
   * signal: linking a record to a second case changes its case membership while
   * leaving the boolean at `true`. Counting is strictly more sensitive and
   * costs nothing.
   */
  caseLinkCount: number;

  // --- artifact pointers the output may cite --------------------------------
  /** `reportReady` / `reportVersion`, and the target of report citations. */
  latestReportVersion: number | null;
  /** `packageReady` / `packageVersion`, and the target of package citations. */
  verificationPackageVersion: number | null;

  // --- governance state -----------------------------------------------------
  /** Eligibility input: destruction and archive transitions live here. */
  lifecycleState: string | null;
  /** Trash. Presence changes availability; restoring clears it. */
  deletedAt: Date | string | null;
  /** Archive. Same reasoning, separate transition. */
  archivedAt: Date | string | null;
};

/**
 * The OPERATION context a selection is bound to.
 *
 * A record can be globally unchanged while its relationship to this particular
 * operation changes, so the revision is context-bound rather than a property of
 * the evidence alone. Unlinking a record from the case under analysis produces
 * a different revision even though every evidence field is identical.
 *
 * The consequence is deliberate: the same record has DIFFERENT revisions on the
 * Case, Evidence and Reviewer surfaces. Each surface projects and compares its
 * own, and a snapshot from one can never be replayed into another.
 */
export type EvidenceAnalysisContext = {
  /** Which copilot operation the snapshot was taken for. */
  scope: "case" | "evidence" | "reviewer";
  /** The subject — a case id, a review id — or null where there is none. */
  scopeId: string | null;
  /**
   * Whether the record is linked to THIS scope, where that is meaningful.
   *
   * `null` on surfaces where scope linkage is not a concept, which is a
   * different statement from `false` and is preserved as one.
   */
  linkedToScope: boolean | null;
};

/**
 * Canonical JSON — deterministic, and lossless about the distinctions that
 * matter.
 *
 * `null`, `false`, `0`, `""` and MISSING are five different states and each
 * must produce different bytes: a package that does not exist is not a package
 * at version zero, and that exact collapse is the defect this replaces. So keys
 * are emitted in a fixed order with their values typed, rather than passed
 * through anything that might drop or coerce them.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"~undefined"';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite value in revision snapshot");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    // Key order is fixed by SORTING, not by insertion, so two callers building
    // the same facts in a different order cannot produce different revisions.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`unserializable value in revision snapshot: ${typeof value}`);
}

/**
 * A timestamp as a canonical UTC instant.
 *
 * ISO-8601 in UTC, never a locale rendering: `toISOString` is stable across
 * hosts and time zones, so the same record does not produce two revisions on
 * two servers.
 */
function canonicalInstant(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (Number.isNaN(ms)) throw new Error("invalid timestamp in revision snapshot");
  return d.toISOString();
}

/**
 * The canonical snapshot string a revision is the digest of.
 *
 * Exported so tests can assert what the revision actually covers, and so a
 * mismatch can be diagnosed without reversing a digest. It is never returned to
 * a client — it contains the record's metadata in the clear, which is precisely
 * why the projected value is the digest and not this.
 */
export function canonicalEvidenceAnalysisSnapshot(
  facts: EvidenceAnalysisFacts,
  context: EvidenceAnalysisContext,
): string {
  return canonicalJson({
    v: EVIDENCE_ANALYSIS_REVISION_SCHEMA,
    evidence: {
      id: facts.id,
      teamId: facts.teamId,
      title: facts.title,
      type: facts.type,
      mimeType: facts.mimeType,
      status: facts.status,
      verificationStatus: facts.verificationStatus,
      captureMethod: facts.captureMethod,
      tsaStatus: facts.tsaStatus,
      otsStatus: facts.otsStatus,
      createdAtUtc: canonicalInstant(facts.createdAtUtc),
      partCount: facts.partCount,
      custodyEventCount: facts.custodyEventCount,
      caseLinkCount: facts.caseLinkCount,
      latestReportVersion: facts.latestReportVersion,
      verificationPackageVersion: facts.verificationPackageVersion,
      lifecycleState: facts.lifecycleState,
      deletedAt: canonicalInstant(facts.deletedAt),
      archivedAt: canonicalInstant(facts.archivedAt),
    },
    context: {
      scope: context.scope,
      scopeId: context.scopeId,
      linkedToScope: context.linkedToScope,
    },
  });
}

/**
 * THE revision for one record in one operation context.
 *
 * Deterministic: the same persisted state always yields the same token, so a
 * client that re-reads without any change gets the value it already held.
 */
export function buildEvidenceAnalysisRevision(
  facts: EvidenceAnalysisFacts,
  context: EvidenceAnalysisContext,
): string {
  return `${EVIDENCE_ANALYSIS_REVISION_SCHEMA}_${sha256Base64Url(
    canonicalEvidenceAnalysisSnapshot(facts, context),
  )}`;
}
