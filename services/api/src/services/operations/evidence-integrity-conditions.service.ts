/**
 * EVIDENCE INTEGRITY CONDITIONS (Attention Architecture, Phase 3).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * The writer that turns per-Evidence TSA and OTS failures into SHARED
 * operational conditions, and resolves them from Evidence domain truth.
 *
 * It EXTENDS the existing Operations infrastructure — `OperationalIncident`,
 * `OperationalIncidentEvent`, `recordIncident` — rather than introducing a
 * second one. There is no `OperationalConditionV2`, no `EvidenceOperationsV2`
 * and no new queue: a domain truth with two lifecycle state machines is the
 * failure this whole program is written to prevent, and building a parallel
 * operations model would be that failure at the largest possible scale.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY (Phase 3.1)
 * ---------------------------------------------------------------------------
 *   tsa_failure:<evidenceId>
 *   ots_failure:<evidenceId>
 *
 * One condition per record per failure class. NOT per filename, per reason,
 * per provider, per workspace or per day — a genuine failure on ten records
 * is ten records that cannot be proven, and every one of them has to be fixed
 * individually before that record is whole again.
 *
 * The fingerprint contains NOTHING that can change while the failure persists.
 * The reason can be rewritten by a retry, the provider can be swapped, the
 * severity escalates with age — and through all of it this is still the same
 * condition, with the same history and the same acknowledgement.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION (Phase 3.4)
 * ---------------------------------------------------------------------------
 * A condition resolves when `Evidence.tsaStatus` / `Evidence.otsStatus`
 * leaves FAILED — read POSITIVELY, per condition, from the Evidence row.
 *
 * It never resolves because a record was absent from a capped scan. The
 * resolver below re-reads each open condition's own Evidence by id, so a
 * truncated or degraded listing can only ever cause a MISSED resolution
 * (harmless: the condition stays open and resolves on the next pass), never a
 * FALSE one (unrecoverable: a system-stamped resolution on a record that is
 * still unprovable).
 *
 * ---------------------------------------------------------------------------
 * SUPPRESSION vs RE-FIRE (Phase 3.5)
 * ---------------------------------------------------------------------------
 * `recordIncident` reopens both RESOLVED and SUPPRESSED rows on a fresh
 * occurrence. That is right for RESOLVED and wrong for SUPPRESSED here,
 * because this writer re-observes a CONTINUING failure on every scan: a
 * suppressed condition would be un-suppressed within minutes, and
 * `OPERATIONS_SUPPRESS` would be a button that does nothing.
 *
 * So:
 *   RESOLVED  + observed FAILED  -> REOPEN. Resolution meant the record
 *                                   recovered, so this is a genuinely new
 *                                   failure occurrence.
 *   SUPPRESSED + observed FAILED -> stays suppressed. The occurrence is still
 *                                   written to history; the operator's
 *                                   decision stands.
 *   SUPPRESSED + observed RECOVERED -> resolves. Domain truth outranks a
 *                                   suppression: the thing is actually fixed,
 *                                   and a later failure then reopens cleanly.
 *
 * Personal notification state — read, archived, deferred — is not an input to
 * any of this. It is not passed in and cannot be.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import type { IncidentCategory, IncidentSeverity } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  isOtsPendingAged,
  OTS_PENDING_STATUSES,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";
import {
  decideObservationTransition,
  type IncidentTransitionStatus,
} from "@proovra/shared-runtime";

import { recordIncident } from "../observability/incident.service.js";
import { inSourceStage } from "./operations-source-diagnostics.js";
import {
  classifyIntegrityFailure,
  describeFailureClass,
  deriveIntegritySeverity,
  type IntegrityFailureClass,
} from "./evidence-integrity-severity.js";
import {
  deriveParentCorrelation,
  type CorrelationEvidence,
} from "./evidence-integrity-correlation.js";

/** The two integrity proofs a record can be missing. */
export type IntegrityClass = "tsa_failure" | "ots_failure";

export const INTEGRITY_CLASSES: readonly IntegrityClass[] = Object.freeze([
  "tsa_failure",
  "ots_failure",
]);

export const EVIDENCE_INTEGRITY_CATEGORY: IncidentCategory =
  "EVIDENCE_INTEGRITY";

/** The terminal status both pipelines write when a proof could not be made. */
const FAILED = "FAILED";

/**
 * THE fingerprint. Exported and used by every caller so no surface can
 * compute a second one and end up adjudicating a condition nobody else sees.
 */
export function integrityConditionFingerprint(
  integrityClass: IntegrityClass,
  evidenceId: string,
): string {
  return `${integrityClass}:${evidenceId}`;
}

/**
 * THE AGED-PENDING fingerprint. A DIFFERENT class from the two FAILED ones,
 * deliberately: a proof that is still trying and a proof that gave up are
 * different operational conditions with different remediations, and collapsing
 * them would make a record recovering from one look like the other.
 */
export const OTS_PENDING_AGED_CLASS = "ots_pending_aged" as const;

export function otsPendingAgedFingerprint(evidenceId: string): string {
  return `${OTS_PENDING_AGED_CLASS}:${evidenceId}`;
}

/** The evidence id an aged-pending fingerprint names, or null. */
export function parseOtsPendingAgedFingerprint(
  fingerprint: string,
): string | null {
  const prefix = `${OTS_PENDING_AGED_CLASS}:`;
  if (!fingerprint.startsWith(prefix)) return null;
  const evidenceId = fingerprint.slice(prefix.length);
  return /^[A-Za-z0-9-]{8,64}$/.test(evidenceId) ? evidenceId : null;
}

/** Parse a fingerprint back into its two parts, or null if it is not ours. */
export function parseIntegrityFingerprint(
  fingerprint: string,
): { integrityClass: IntegrityClass; evidenceId: string } | null {
  const colon = fingerprint.indexOf(":");
  if (colon < 1) return null;
  const head = fingerprint.slice(0, colon);
  if (!INTEGRITY_CLASSES.includes(head as IntegrityClass)) return null;
  const evidenceId = fingerprint.slice(colon + 1);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(evidenceId)) return null;
  return { integrityClass: head as IntegrityClass, evidenceId };
}

type EvidenceIntegrityRow = {
  id: string;
  teamId: string | null;
  title: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;
  tsaProvider: string | null;
  otsStatus: string | null;
  otsFailureReason: string | null;
  otsUpgradedAtUtc: Date | null;
  /** The earliest pinned anchor, when one exists. Read-only, for aging. */
  otsAnchoredAtUtc: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * CLOSURE PASS (2026-08-22) — the POSITIVE correlator, when one exists.
   *
   * Set only by a deliberate multi-record execution (a repair run, a bulk
   * re-anchor). NULL for ordinary per-record work, which is independent by
   * construction — and NULL is the correct, common answer.
   */
  integrityCorrelationId: string | null;
};

const EVIDENCE_SELECT = {
  id: true,
  teamId: true,
  title: true,
  tsaStatus: true,
  tsaFailureReason: true,
  tsaProvider: true,
  otsStatus: true,
  otsFailureReason: true,
  otsUpgradedAtUtc: true,
  otsAnchoredAtUtc: true,
  createdAt: true,
  updatedAt: true,
  integrityCorrelationId: true,
} as const;

function failureReasonFor(
  row: EvidenceIntegrityRow,
  integrityClass: IntegrityClass,
): string | null {
  return integrityClass === "tsa_failure"
    ? row.tsaFailureReason
    : row.otsFailureReason;
}

function statusFor(
  row: Pick<EvidenceIntegrityRow, "tsaStatus" | "otsStatus">,
  integrityClass: IntegrityClass,
): string | null {
  return integrityClass === "tsa_failure" ? row.tsaStatus : row.otsStatus;
}

/** Is this record CURRENTLY failing this proof? Positive, from the row. */
export function isCurrentlyFailing(
  row: Pick<EvidenceIntegrityRow, "tsaStatus" | "otsStatus">,
  integrityClass: IntegrityClass,
): boolean {
  return statusFor(row, integrityClass) === FAILED;
}

const PROOF_LABEL: Record<IntegrityClass, string> = {
  tsa_failure: "RFC3161 timestamp",
  ots_failure: "OpenTimestamps anchor",
};

export type SyncResult = {
  /** Conditions opened for the first time on this pass. */
  opened: number;
  /** Existing conditions whose continued failure was recorded. */
  reobserved: number;
  /** Conditions resolved because the record recovered. */
  resolved: number;
  /** Suppressed conditions left suppressed despite a continuing failure. */
  suppressedUntouched: number;
  /**
   * PHASE 2.2 — did this pass read the whole failing set?
   *
   * False means a scan bound was reached. Nothing may conclude "no more
   * failures exist" from a pass where this is false.
   */
  complete: boolean;
};

/**
 * A generous bound on one pass. Not a silent cap: reaching it sets
 * `complete: false`, which every consumer of this result must honour.
 */
const SCAN_BOUND = 2000;

/**
 * Open, re-observe and resolve every Evidence integrity condition in one
 * workspace.
 *
 * Idempotent by construction (Phase 3.3): the identity is the fingerprint,
 * the write is an upsert on `(teamId, fingerprint)`, and re-running over an
 * unchanged workspace opens nothing new.
 */
export async function syncEvidenceIntegrityConditions(
  input: { teamId: string; now?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<SyncResult> {
  const now = input.now ?? new Date();
  const result: SyncResult = {
    opened: 0,
    reobserved: 0,
    resolved: 0,
    suppressedUntouched: 0,
    complete: true,
  };

  // -------------------------------------------------------------------------
  // 1. OPEN / RE-OBSERVE — every record currently failing either proof.
  //
  // WORKSPACE SCOPE IS RESOLVED BY THE CANONICAL AUTHORITY, not by a raw
  // `teamId` equality. On a PERSONAL workspace the failing records are the
  // legacy `team_id = NULL` rows the capture path wrote, owned by the personal
  // user; a strict `teamId` filter matches NONE of them, so this scan found
  // nothing, materialised nothing, and Operations rendered "clear" while Home
  // — which already uses `workspaceEvidenceWhere` — counted the same failures
  // as CRITICAL. `workspaceEvidenceWhere` widens to the owner's NULL-team rows
  // for a personal workspace ONLY, bound to that one owner's userId, so a real
  // team workspace keeps the strict filter and no cross-tenant row can leak.
  //
  // Combined under AND: the scope filter can itself be an `OR` (personal), and
  // the failure filter is a second `OR`, so they cannot share one object level.
  // Tagged SCAN so the sweep that catches this pass can say WHICH half gave
  // way. From out there the two are indistinguishable, and a caller that
  // guesses would report "could not look" for a workspace whose real state is
  // "looked, found conditions, could not record them".
  const scopeWhere = await inSourceStage("SCAN", () =>
    workspaceEvidenceWhere(input.teamId, client),
  );
  const failing = (await inSourceStage("SCAN", () => client.evidence.findMany({
    where: {
      AND: [
        scopeWhere,
        { deletedAt: null },
        {
          OR: [
            { tsaStatus: FAILED },
            { otsStatus: FAILED },
            // AGED-PENDING. Selected broadly here — every record still in a
            // trying state — and narrowed by the SHARED age predicate below,
            // because the window is configurable and a SQL cutoff computed
            // here would be a second copy of it.
            { otsStatus: { in: [...OTS_PENDING_STATUSES] } },
          ],
        },
      ],
    },
    select: EVIDENCE_SELECT,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: SCAN_BOUND + 1,
  }))) as EvidenceIntegrityRow[];

  if (failing.length > SCAN_BOUND) {
    result.complete = false;
    failing.length = SCAN_BOUND;
  }

  // Legal-hold posture, read once for the whole batch rather than per record.
  const heldEvidenceIds = await inSourceStage("SCAN", () =>
    activeLegalHoldEvidenceIds(
      client,
      failing.map((e) => e.id),
    ),
  );

  for (const row of failing) {
    for (const integrityClass of INTEGRITY_CLASSES) {
      if (!isCurrentlyFailing(row, integrityClass)) continue;
      // WRITE: the condition has been OBSERVED by this point. A failure
      // here leaves a real, unrecorded condition in the workspace, which is
      // the strictly worse of the two stages and must be reported as such.
      const outcome = await inSourceStage("WRITE", () =>
        recordIntegrityCondition(
          {
            evidence: row,
            integrityClass,
            teamId: input.teamId,
            underLegalHold: heldEvidenceIds.has(row.id),
            now,
          },
          client,
        ),
      );
      if (outcome === "opened") result.opened += 1;
      else if (outcome === "reobserved") result.reobserved += 1;
      else result.suppressedUntouched += 1;
    }

    // -----------------------------------------------------------------------
    // AGED-PENDING — a proof still trying, past the canonical window.
    //
    // `evidence_integrity.ots_pending_aged` sat in the registry for a release
    // with a probe, a threshold and NO PRODUCER: this loop iterated the two
    // FAILED classes only, so the source looked covered and observed nothing.
    // A record that had been trying to anchor for months was invisible until
    // the Worker finally marked it FAILED.
    //
    // The predicate is the SHARED one — the same arithmetic over the same
    // global budget the Worker uses to decide it has given up — so the
    // Operations page and the Worker cannot disagree about which records are
    // out of time.
    //
    // READ-ONLY. Nothing here contacts a calendar server, retries an anchor,
    // replaces a proof or writes to the Evidence row.
    if (isOtsPendingAged(row, now)) {
      const outcome = await inSourceStage("WRITE", () =>
        recordOtsPendingAgedCondition(
          {
            evidence: row,
            teamId: input.teamId,
            underLegalHold: heldEvidenceIds.has(row.id),
            now,
          },
          client,
        ),
      );
      if (outcome === "opened") result.opened += 1;
      else if (outcome === "reobserved") result.reobserved += 1;
      else result.suppressedUntouched += 1;
    }
  }

  // -------------------------------------------------------------------------
  // 2. RESOLVE — from Evidence domain truth, read per condition.
  //
  // Note what this does NOT do: it does not diff the failing set above
  // against the open conditions. That diff would resolve on ABSENCE, and
  // absence from a bounded scan is not evidence of anything (Phase 2.2). Each
  // open condition's own Evidence row is re-read by id instead.
  // -------------------------------------------------------------------------
  result.resolved = await inSourceStage("WRITE", () =>
    resolveRecoveredConditions({ teamId: input.teamId, scopeWhere, now }, client),
  );
  // The aged-pending family has its own recovery predicate — a proof that
  // anchored, or that the Worker moved to FAILED — so it has its own resolver
  // rather than a branch inside the one above.
  result.resolved += await inSourceStage("WRITE", () =>
    resolveRecoveredOtsPendingAged(
      { teamId: input.teamId, scopeWhere, now },
      client,
    ),
  );

  return result;
}

type RecordOutcome = "opened" | "reobserved" | "suppressed_untouched";

async function recordIntegrityCondition(
  args: {
    evidence: EvidenceIntegrityRow;
    integrityClass: IntegrityClass;
    teamId: string;
    underLegalHold: boolean;
    now: Date;
  },
  client: PrismaClient,
): Promise<RecordOutcome> {
  const { evidence, integrityClass, teamId, now } = args;
  const fingerprint = integrityConditionFingerprint(
    integrityClass,
    evidence.id,
  );

  const existing = await client.operationalIncident.findUnique({
    where: {
      teamId_fingerprint: { teamId, fingerprint } as never,
    },
    select: { id: true, status: true, firstSeenAtUtc: true },
  });

  // SUPPRESSION IS NO LONGER DECIDED HERE.
  //
  // This branch used to intercept a suppressed condition and hand-write the
  // occurrence itself, which made it a SECOND transition tree beside
  // `recordIncident` — and the one place in the product where suppression
  // survived a re-observation. Every other source reached `recordIncident`
  // directly and had its suppression silently erased.
  //
  // The rule now lives in the shared transition authority, which preserves
  // SUPPRESSED for every category and writes the same
  // `occurrence_while_suppressed` event. Keeping this copy would mean the one
  // source that behaved correctly was the one still bypassing the fix.
  const wasSuppressed =
    existing?.status === prismaPkg.IncidentStatus.SUPPRESSED;

  const failureClass: IntegrityFailureClass = classifyIntegrityFailure(
    failureReasonFor(evidence, integrityClass),
  );
  const severity: IncidentSeverity = deriveIntegritySeverity({
    failureClass,
    // A condition we have never seen starts its clock now; an existing one
    // keeps the clock it started with, so age escalation measures how long
    // the PROBLEM has existed rather than how long since the last scan.
    firstSeenAtUtc: existing?.firstSeenAtUtc ?? now,
    now,
    underLegalHold: args.underLegalHold,
  });

  const proof = PROOF_LABEL[integrityClass];
  const recordLabel = evidence.title?.trim()
    ? `"${evidence.title.trim().slice(0, 80)}"`
    : `record ${evidence.id.slice(0, 8)}`;

  // ---------------------------------------------------------------------
  // CORRELATION (Phase 3.7, producer wired in the closure pass).
  //
  // `Evidence.integrityCorrelationId` is the ONE positive correlator the
  // current pipelines can honestly produce: the identity of a DELIBERATE
  // multi-record execution. Ordinary TSA and OTS work is one BullMQ job per
  // Evidence — `processOtsUpgrade` decodes exactly one `commandId` — so for
  // normal production failures this is NULL and no parent is formed.
  //
  // NULL IS THE COMMON, CORRECT ANSWER. Nothing here falls back to provider,
  // workspace, filename, reason or time: those are resemblance, and grouping
  // on resemblance is the retracted finding.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // CORRELATION (Phase 3.7, producer wired in the closure pass).
  //
  // `Evidence.integrityCorrelationId` is the ONE positive correlator the
  // current pipelines can honestly produce: the identity of a DELIBERATE
  // multi-record execution. Ordinary TSA and OTS work is one BullMQ job per
  // Evidence — `processOtsUpgrade` decodes exactly one `commandId` — so for
  // normal production failures this is NULL and no parent is formed.
  //
  // NULL IS THE COMMON, CORRECT ANSWER. Nothing here falls back to provider,
  // workspace, filename, reason or time: those are resemblance, and grouping
  // on resemblance is the retracted finding.
  // ---------------------------------------------------------------------
  const correlationEvidence: CorrelationEvidence = {
    providerIncidentId: null,
    persistedCorrelationId: evidence.integrityCorrelationId,
    batchRunId: null,
    retryExecutionId: null,
  };
  const parent = deriveParentCorrelation(correlationEvidence);

  const { created } = await recordIncident(
    {
      // The class IS the source: two integrity failures, two contracts.
      sourceId:
        integrityClass === "tsa_failure"
          ? "evidence_integrity.tsa_failed"
          : "evidence_integrity.ots_failed",
      teamId,
      category: EVIDENCE_INTEGRITY_CATEGORY,
      severity,
      fingerprint,
      title: `${proof} missing for ${recordLabel}`,
      safeSummary:
        `This record has no ${proof}: ${describeFailureClass(failureClass)}. ` +
        `It stays unresolved until the record's own ${integrityClass === "tsa_failure" ? "tsaStatus" : "otsStatus"} ` +
        `leaves FAILED. Each affected record is tracked separately — this condition covers one record only.`,
      relatedEvidenceId: evidence.id,
      relatedProvider:
        integrityClass === "tsa_failure" ? evidence.tsaProvider : null,
      runbookSlug: "evidence-integrity",
      metadata: {
        integrityClass,
        failureClass,
        underLegalHold: args.underLegalHold,
        parentFingerprint: parent?.parentFingerprint ?? null,
        correlationBasis: parent?.basis ?? null,
      },
    },
    client,
  );

  if (wasSuppressed) return "suppressed_untouched";
  return created ? "opened" : "reobserved";
}

/**
 * OPEN OR RE-OBSERVE AN AGED-PENDING OTS CONDITION.
 *
 * A record whose OpenTimestamps proof is still trying, past the canonical
 * global anchoring budget. Deliberately its own condition class rather than a
 * variant of `ots_failure`:
 *
 *   * they mean different things — one is "still trying, too long", the other
 *     is "the platform gave up" — and an operator triaging them does different
 *     work;
 *   * they recover differently. Aged-pending recovers when the proof anchors
 *     OR when the Worker gives up and moves the record to FAILED, at which
 *     point its FAILED sibling opens. Collapsing the two would make that
 *     handover look like a single condition quietly changing meaning.
 *
 * Severity does not escalate with age here the way a FAILED proof's does. The
 * record has ALREADY exceeded the window by the time this opens, so age past
 * that point is not new information — it is the same fact, longer.
 *
 * READ-ONLY with respect to the proof. This function contacts no calendar
 * server and writes nothing to the Evidence row; it records an operational
 * condition and nothing else.
 */
async function recordOtsPendingAgedCondition(
  args: {
    evidence: EvidenceIntegrityRow;
    teamId: string;
    underLegalHold: boolean;
    now: Date;
  },
  client: PrismaClient,
): Promise<RecordOutcome> {
  const { evidence, teamId } = args;
  const fingerprint = otsPendingAgedFingerprint(evidence.id);

  const existing = await client.operationalIncident.findUnique({
    where: { teamId_fingerprint: { teamId, fingerprint } as never },
    select: { id: true, status: true },
  });
  const wasSuppressed =
    existing?.status === prismaPkg.IncidentStatus.SUPPRESSED;

  const recordLabel = evidence.title?.trim()
    ? `"${evidence.title.trim().slice(0, 80)}"`
    : `record ${evidence.id.slice(0, 8)}`;

  const { created } = await recordIncident(
    {
      sourceId: "evidence_integrity.ots_pending_aged",
      teamId,
      category: EVIDENCE_INTEGRITY_CATEGORY,
      // WARNING and not HIGH. The record IS provable — its RFC3161 timestamp
      // is unaffected — and what is missing is the secondary public-chain
      // anchor. Ranking it beside a record that cannot be timestamped at all
      // would make the queue's worst rows harder to find.
      severity: "WARNING" as IncidentSeverity,
      fingerprint,
      title: `Blockchain anchoring still pending for ${recordLabel}`,
      safeSummary:
        "This record's OpenTimestamps anchor has not settled within the platform's anchoring window. " +
        "The record's own trusted timestamp is unaffected and the record remains valid evidence; " +
        "the public-chain anchor is a second, independent proof that is still outstanding.",
      relatedEvidenceId: evidence.id,
      runbookSlug: "ots-anchoring",
      metadata: {
        integrityClass: OTS_PENDING_AGED_CLASS,
        otsStatus: evidence.otsStatus,
        underLegalHold: args.underLegalHold,
      },
    },
    client,
  );

  if (wasSuppressed) return "suppressed_untouched";
  return created ? "opened" : "reobserved";
}

/**
 * Resolve aged-pending conditions whose record no longer qualifies.
 *
 * Positive evidence only, and through the SAME shared predicate discovery
 * used: a record that has since anchored, or that the Worker has moved to
 * FAILED, is no longer an aged-pending condition and the row says so. A record
 * that cannot be read leaves the condition open — "we could not check" is not
 * "it is fine".
 *
 * The handover to `ots_failure` is deliberate and visible: when the Worker
 * gives up, this condition resolves from source truth and its FAILED sibling
 * opens on the next pass, so the timeline shows one condition ending and
 * another beginning rather than one silently changing meaning.
 */
async function resolveRecoveredOtsPendingAged(
  args: {
    teamId: string;
    scopeWhere: prismaPkg.Prisma.EvidenceWhereInput;
    now: Date;
  },
  client: PrismaClient,
): Promise<number> {
  const open = await client.operationalIncident.findMany({
    where: {
      teamId: args.teamId,
      category: EVIDENCE_INTEGRITY_CATEGORY as prismaPkg.IncidentCategory,
      fingerprint: { startsWith: `${OTS_PENDING_AGED_CLASS}:` },
      status: {
        in: [
          prismaPkg.IncidentStatus.OPEN,
          prismaPkg.IncidentStatus.ACKNOWLEDGED,
          // Domain truth outranks a suppression: a silenced condition whose
          // record actually anchored IS over, and leaving it suppressed-but-
          // settled would make the next genuine delay read as a continuation.
          prismaPkg.IncidentStatus.SUPPRESSED,
        ],
      },
    },
    select: { id: true, fingerprint: true, status: true },
    orderBy: [{ lastSeenAtUtc: "desc" }, { id: "desc" }],
  });
  if (open.length === 0) return 0;

  const parsed = open
    .map((row) => ({ row, evidenceId: parseOtsPendingAgedFingerprint(row.fingerprint) }))
    .filter(
      (e): e is { row: (typeof open)[number]; evidenceId: string } =>
        e.evidenceId != null,
    );
  if (parsed.length === 0) return 0;

  const rows = await client.evidence.findMany({
    where: {
      AND: [
        { id: { in: [...new Set(parsed.map((e) => e.evidenceId))] } },
        args.scopeWhere,
      ],
    },
    select: {
      id: true,
      otsStatus: true,
      otsAnchoredAtUtc: true,
      createdAt: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  let resolved = 0;
  for (const { row, evidenceId } of parsed) {
    const evidence = byId.get(evidenceId);
    // Unreadable or gone: NOT proof of recovery. Leave it open.
    if (!evidence) continue;
    if (isOtsPendingAged(evidence, args.now)) continue;

    const decision = decideObservationTransition({
      currentStatus: row.status as IncidentTransitionStatus,
      observation: "SOURCE_RECOVERED",
    });
    if (decision !== "AUTO_RESOLVE_SOURCE_RECOVERY") continue;

    await client.operationalIncident.update({
      where: { id: row.id },
      data: {
        status: prismaPkg.IncidentStatus.RESOLVED,
        resolvedAtUtc: args.now,
        // No human resolver is fabricated for a domain-truth resolution.
        resolvedByUserId: null,
        resolutionNote:
          "Resolved from Evidence domain truth: the record is no longer an aged-pending OpenTimestamps anchor.",
        // `acknowledgedAtUtc` / `acknowledgedByUserId` are DELIBERATELY left
        // alone. Who took this on is part of what happened to it.
      },
    });
    await client.operationalIncidentEvent
      .create({
        data: {
          incidentId: row.id,
          eventType: "resolved_by_domain_truth",
          safeMessage:
            "The record's OpenTimestamps status left the aged-pending window. Resolved from positive domain evidence, not from absence in a scan.",
          metadataJson: {
            integrityClass: OTS_PENDING_AGED_CLASS,
            observedStatus: evidence.otsStatus,
            previousStatus: row.status,
          } as prismaPkg.Prisma.InputJsonValue,
        },
      })
      .catch(() => null);

    await import("./incident-sla-cycle.service.js")
      .then((cycles) =>
        cycles.closeSlaCycle({ incidentId: row.id, reason: "RESOLVED" }, client),
      )
      .catch(() => null);

    resolved += 1;
  }
  return resolved;
}


/**
 * Resolve conditions whose record has RECOVERED.
 *
 * Positive evidence only: each open condition names its Evidence, that
 * Evidence is read by id, and the condition resolves only when the relevant
 * status column is observably no longer FAILED. A record that has been
 * deleted, or whose row cannot be read, leaves the condition OPEN — we do not
 * know that it recovered, and "we could not check" is not "it is fine".
 */
async function resolveRecoveredConditions(
  args: {
    teamId: string;
    /** The canonical workspace scope, resolved once by the caller. */
    scopeWhere: prismaPkg.Prisma.EvidenceWhereInput;
    now: Date;
  },
  client: PrismaClient,
): Promise<number> {
  const open = await client.operationalIncident.findMany({
    where: {
      teamId: args.teamId,
      category: EVIDENCE_INTEGRITY_CATEGORY as prismaPkg.IncidentCategory,
      status: {
        in: [
          prismaPkg.IncidentStatus.OPEN,
          prismaPkg.IncidentStatus.ACKNOWLEDGED,
          // A suppressed condition whose record actually recovered is
          // resolved: domain truth outranks a suppression, and leaving it
          // suppressed-but-fixed would make the next genuine failure look
          // like a continuation of the old one.
          prismaPkg.IncidentStatus.SUPPRESSED,
        ],
      },
    },
    select: { id: true, fingerprint: true, status: true },
    orderBy: [{ lastSeenAtUtc: "desc" }, { id: "desc" }],
  });
  if (open.length === 0) return 0;

  const parsed = open
    .map((row) => ({ row, parts: parseIntegrityFingerprint(row.fingerprint) }))
    .filter(
      (entry): entry is { row: (typeof open)[number]; parts: NonNullable<ReturnType<typeof parseIntegrityFingerprint>> } =>
        entry.parts != null,
    );
  if (parsed.length === 0) return 0;

  // The SAME canonical scope the discovery pass used. A personal workspace's
  // recovered records are legacy `team_id = NULL` rows; a strict `teamId`
  // filter here would read zero of them, so a condition opened for a personal
  // record could never observe its own recovery and would stay open forever.
  // Still an AND with the id set: the scope may itself be an `OR`.
  const evidenceRows = await client.evidence.findMany({
    where: {
      AND: [
        { id: { in: [...new Set(parsed.map((e) => e.parts.evidenceId))] } },
        args.scopeWhere,
      ],
    },
    select: { id: true, tsaStatus: true, otsStatus: true },
  });
  const statusById = new Map(evidenceRows.map((row) => [row.id, row]));

  let resolved = 0;
  for (const { row, parts } of parsed) {
    const evidence = statusById.get(parts.evidenceId);
    // Unreadable or gone: NOT proof of recovery. Leave it open.
    if (!evidence) continue;
    if (isCurrentlyFailing(evidence, parts.integrityClass)) continue;

    // The SHARED authority decides, here as in the writer. A recovery
    // observation may close OPEN, ACKNOWLEDGED and SUPPRESSED alike: domain
    // truth outranks both ownership and silencing.
    const decision = decideObservationTransition({
      currentStatus: row.status as IncidentTransitionStatus,
      observation: "SOURCE_RECOVERED",
    });
    if (decision !== "AUTO_RESOLVE_SOURCE_RECOVERY") continue;

    await client.operationalIncident.update({
      where: { id: row.id },
      data: {
        status: prismaPkg.IncidentStatus.RESOLVED,
        resolvedAtUtc: args.now,
        // No human resolver is fabricated for a domain-truth resolution.
        resolvedByUserId: null,
        resolutionNote: `Resolved from Evidence domain truth: ${
          parts.integrityClass === "tsa_failure" ? "tsaStatus" : "otsStatus"
        } is no longer FAILED.`,
        // `acknowledgedAtUtc` / `acknowledgedByUserId` are DELIBERATELY left
        // alone. Who took this on is part of what happened to it, and a
        // resolution is not a reason to forget. They are cleared only by a
        // genuine reopen, which starts a new cycle that nobody owns yet.
      },
    });
    await client.operationalIncidentEvent
      .create({
        data: {
          incidentId: row.id,
          eventType: "resolved_by_domain_truth",
          safeMessage:
            "The record's own integrity status left FAILED. Resolved from positive domain evidence, not from absence in a scan.",
          metadataJson: {
            integrityClass: parts.integrityClass,
            observedStatus:
              statusById.get(parts.evidenceId)?.[
                parts.integrityClass === "tsa_failure" ? "tsaStatus" : "otsStatus"
              ] ?? null,
            previousStatus: row.status,
          } as prismaPkg.Prisma.InputJsonValue,
        },
      })
      .catch(() => null);

    // CLOSE THE PROMISE. A condition resolved from domain truth discharges
    // its SLA cycle exactly as an operator resolution does; leaving the cycle
    // live would make a recovered condition read as still owing a commitment,
    // and would make `openSlaCycle` decline the next genuine recurrence.
    await import("./incident-sla-cycle.service.js")
      .then((cycles) =>
        cycles.closeSlaCycle({ incidentId: row.id, reason: "RESOLVED" }, client),
      )
      .catch(() => null);

    resolved += 1;
  }
  return resolved;
}

/**
 * Which of these records are under an ACTIVE legal hold?
 *
 * Read once per batch. A failure to read fails CLOSED for severity purposes
 * (no escalation) rather than throwing — an unavailable hold table must not
 * stop integrity conditions from being opened at all.
 */
async function activeLegalHoldEvidenceIds(
  client: PrismaClient,
  evidenceIds: string[],
): Promise<Set<string>> {
  if (evidenceIds.length === 0) return new Set();
  try {
    const holds = await client.evidenceLegalHold.findMany({
      where: {
        evidenceId: { in: evidenceIds },
        // ACTIVE status AND not past expiry. The schema is explicit that a
        // passed expiry does NOT auto-release — the status column only moves
        // to EXPIRED by an explicit sweep — so reading `status` alone would
        // treat a lapsed hold as live and escalate severity on records nobody
        // is obliged to preserve any more.
        status: "ACTIVE",
        OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: new Date() } }],
      },
      select: { evidenceId: true },
    });
    return new Set(
      holds
        .map((h) => h.evidenceId)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return new Set();
  }
}
