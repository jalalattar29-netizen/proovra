/**
 * THE canonical per-record output lifecycle projection.
 *
 * Side-effect-free. Touches no custody, audit, view or download counter.
 *
 * ---------------------------------------------------------------------------
 * COMMERCIAL + EVIDENCE OUTPUT LIFECYCLE CLOSURE (2026-09-08)
 * ---------------------------------------------------------------------------
 * What this helper used to be, and why it was wrong:
 *
 *     const reportPending = finalized && !latestReport;
 *
 * It had no commercial input at all, so "no Report row" meant PENDING. On a
 * Free account — where the completion fan-out deliberately never enqueues a
 * report, because Free does not include one — that evaluated to `pending: true`
 * for the life of the record. The product told those customers their report was
 * "still being generated" forever, and every downstream reader inherited it:
 * reviewer alerts, the Reports page, the operational backlog counters.
 *
 * The `unavailableReason` enum was declared as `never` with a note saying it was
 * "reserved for future cases (e.g., a workspace plan that genuinely excludes
 * packages)". That case was not in the future; it was the most common case in
 * production, and nothing could express it.
 *
 * This module now resolves all THREE axes the shared state machine separates —
 * commercial eligibility, generation execution, artifact availability — and
 * derives one customer-facing state from them. It decides nothing commercial
 * itself: `resolveEvidenceOutputEntitlements` (@proovra/shared-billing) is the
 * one authority for eligibility, and it is asked with BOTH the effective plan
 * and this record's own funding, so a credit-funded record on a Free account
 * reads ELIGIBLE.
 *
 * The legacy `available` / `pending` / `blocked` / `unavailable` booleans are
 * RETAINED on the shape and now carry correct values, so no consumer had to be
 * migrated blind. New consumers read `state`.
 */
import * as prismaPkg from "@prisma/client";
import {
  PDF_SIGNING_UNAVAILABLE_COPY,
  PDF_UNSIGNED_OPT_OUT_WARNING_COPY,
  classifyTerminalReason,
  deriveEvidenceOutputState,
  outputActionFor,
  outputNotApplicableReason,
  resolveOfferedOutputAction,
  projectReportRequestState,
  type EvidenceOutputState,
  type OutputAction,
  type OutputArtifactAvailability,
  type OutputCommercialEligibility,
  type OutputGenerationState,
  type OutputIneligibilityReason,
  type OutputActionUnavailableReason,
  type OutputNotApplicableReason,
  type OutputRecordApplicability,
  type OutputTerminalReasonClass,
  type PersistedReportRequestState,
  type PdfSignatureStatus,
  type ReportPdfSignatureProjection,
  type VerificationPackageSignatureProjection,
  type VerificationPackageSignatureStatus,
} from "@proovra/shared";
import { prisma } from "../db.js";
import { resolveEvidenceOutputEligibility } from "./billing/evidence-output-eligibility.service.js";

/**
 * Phase A2 — Bounded set of artifact signature status strings the
 * frontend may consume. Backed by the shared `PdfSignatureStatus`
 * union so the type system catches any drift.
 */
const PDF_STATUSES_RUNTIME: ReadonlySet<PdfSignatureStatus> = new Set([
  "SIGNED",
  "UNSIGNED_OPT_OUT",
  "SIGNING_UNAVAILABLE",
  "SIGNING_FAILED",
  "NOT_APPLICABLE",
]);

function normalizePdfSignatureStatus(
  raw: string | null,
): PdfSignatureStatus | null {
  if (!raw) return null;
  return PDF_STATUSES_RUNTIME.has(raw as PdfSignatureStatus)
    ? (raw as PdfSignatureStatus)
    : null;
}

/**
 * Resolve the operator-facing warning copy from a stored
 * pdf_signing_warning column. When the column is null and we know the
 * status, fall back to the canonical shared copy so the wire is
 * deterministic.
 */
function resolveWarningCopy(
  status: PdfSignatureStatus,
  stored: string | null,
): string | null {
  if (status === "SIGNED" || status === "NOT_APPLICABLE") return null;
  if (stored && stored.trim().length > 0) return stored;
  if (status === "UNSIGNED_OPT_OUT") return PDF_UNSIGNED_OPT_OUT_WARNING_COPY;
  if (status === "SIGNING_UNAVAILABLE") return PDF_SIGNING_UNAVAILABLE_COPY;
  return null;
}

/**
 * Why an output will not be produced.
 *
 * This was `never` — declared and unproducible — with a note reserving it for
 * "a workspace plan that genuinely excludes packages". That plan is FREE, and
 * it is the most common plan in production. The enum is now real and carries
 * the bounded shared reason.
 */
export type VerificationPackageUnavailableReason = OutputIneligibilityReason;

/**
 * THE ONE MAPPING from a persisted `EvidenceStatus` to the record axis.
 *
 * P1-3 CLOSURE (2026-09-10). Three call sites need it — this projection, the
 * Reports aggregator and the user-scoped Reports fallback — and a status
 * string compared inline at each of them is how a fourth status comes to be
 * classified two different ways. It is a pure function of the status, so it
 * takes the status and nothing else.
 *
 * A status this function does not recognise reads `NOT_FINALIZED`, which is
 * the conservative answer: it offers no action and promises nothing.
 */
export function resolveOutputRecordApplicability(
  status: prismaPkg.EvidenceStatus | string | null | undefined,
): OutputRecordApplicability {
  if (status === prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH) {
    return "INTEGRITY_FAILED";
  }
  if (
    status === prismaPkg.EvidenceStatus.SIGNED ||
    status === prismaPkg.EvidenceStatus.REPORTED
  ) {
    return "FINALIZED";
  }
  return "NOT_FINALIZED";
}

/**
 * The three-axis projection for one output, plus the derived state and the
 * action a surface may offer.
 *
 * Rendered surfaces read `state`. Surfaces that explain themselves read the
 * axes. Nothing re-derives any of it.
 */
export type EvidenceOutputProjection = {
  /** Axis 1 — commercial. */
  eligibility: OutputCommercialEligibility;
  ineligibilityReason: OutputIneligibilityReason | null;
  /**
   * P1-3 CLOSURE (2026-09-10) — WHY the output is `NOT_APPLICABLE`.
   *
   * Present only for that state, and bounded. `NOT_FINALIZED` ends when the
   * record finalizes; `INTEGRITY_FAILED` never ends. A surface that renders
   * one sentence for both would tell the owner of a hash-mismatched record to
   * wait for something that is not coming.
   */
  notApplicableReason: OutputNotApplicableReason | null;
  /** Axis 2 — generation execution, projected from the request row. */
  generation: OutputGenerationState;
  /** Class of the terminal reason, when generation is TERMINAL_FAILURE. */
  terminalReasonClass: OutputTerminalReasonClass | null;
  /**
   * The bounded terminal reason code, as persisted. Safe: the worker writes a
   * 64-char code from a closed set, never a message or a stack.
   */
  terminalReasonCode: string | null;
  attemptCount: number | null;
  requestedAtUtc: string | null;
  completedAtUtc: string | null;
  /** Axis 3 — does a finished artifact exist. */
  availability: OutputArtifactAvailability;
  /** The one state a surface renders. */
  state: EvidenceOutputState;
  /** The one action a surface may offer for that state. */
  action: OutputAction;
  /**
   * P2-1 CLOSURE (2026-09-10) — WHY THE VERB WAS WITHDRAWN, when the state
   * would otherwise carry one.
   *
   * `WORKSPACE_UNRESOLVED` is the only member today: a legacy record written
   * before the workspace backfill has a null `teamId`, and
   * `createReportGenerationRequest` refuses such a record because a request
   * that cannot be scoped must not exist. Those records ARE listed — the
   * canonical scope predicate has an owner-scoped arm for exactly them — so
   * without this the product offered Generate and answered the click by
   * claiming the record was not available.
   *
   * It deliberately does NOT change `state`. The record's outputs are what
   * they are: an existing artifact stays READY and stays downloadable, which
   * is the same separation of ownership from generation the downgrade path
   * relies on. Only the verb goes.
   */
  actionUnavailableReason: OutputActionUnavailableReason | null;
};

export interface EvidenceArtifactStatus {
  evidenceId: string;
  status: prismaPkg.EvidenceStatus | null;
  finalized: boolean;
  /**
   * The canonical output lifecycle for this record. New consumers read this;
   * the legacy booleans below are kept in agreement with it.
   */
  outputs: {
    report: EvidenceOutputProjection;
    verificationPackage: EvidenceOutputProjection;
  };
  report:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        reviewerSummaryVersion: number | null;
        verificationPackageVersion: number | null;
        pending: false;
        // Phase A2 — explicit PDF artifact signature projection. The
        // frontend renders signed/unsigned badges ONLY from this
        // block. NEVER from labels or copy strings.
        pdfSignature: ReportPdfSignatureProjection;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        reviewerSummaryVersion: null;
        verificationPackageVersion: null;
        pending: boolean;
        pdfSignature: null;
      };
  // Phase 32.6.1 — `blocked` state distinct from pending / unavailable.
  //   pending     — worker is still working; client should poll
  //   ready       — `available: true`
  //   unavailable — won't ever generate (personal workspace, no team)
  //   blocked     — gate denied (legal hold / destruction review / etc.);
  //                  may become available later if gate condition resolves
  verificationPackage:
    | {
        available: true;
        version: number;
        generatedAtUtc: string;
        packageType: string | null;
        pending: false;
        unavailable: false;
        unavailableReason: null;
        blocked: false;
        blockedOutcome: null;
        blockedReason: null;
        blockedAtUtc: null;
        // Phase A2 — package manifest signature projection. Distinct
        // from PDF signature. Today the worker always signs the
        // manifest with Ed25519 (status SIGNED). Reserved values
        // exist in the union so a future opt-out can record them.
        manifestSignature: VerificationPackageSignatureProjection;
      }
    | {
        available: false;
        version: null;
        generatedAtUtc: null;
        packageType: null;
        pending: boolean;
        unavailable: boolean;
        unavailableReason: VerificationPackageUnavailableReason | null;
        // Phase 32.6.1 — gate-denial state. Reads from the bounded
        // `evidence.verificationPackageMetadata.blocked` shape the
        // worker writes after a PackageGateDeniedError.
        blocked: boolean;
        blockedOutcome: string | null;
        blockedReason: string | null;
        blockedAtUtc: string | null;
        manifestSignature: null;
      };
}

export async function buildEvidenceArtifactStatus(params: {
  evidenceId: string;
  evidenceStatus: prismaPkg.EvidenceStatus | null;
  /** Phase 32.5 — Required for verification-package availability
   *  reasoning. When null, the evidence belongs to a personal
   *  workspace and verification package generation is intentionally
   *  skipped (no governance context). */
  evidenceTeamId: string | null;
  /**
   * The record's OWNER — the commercial subject of its outputs.
   *
   * Required to resolve axis 1. Optional on the signature only so that a
   * caller which genuinely has no owner in hand degrades to plan-blind rather
   * than throwing; every production caller passes it, and the eligibility
   * fallback is FREE (fail closed), not "entitled".
   */
  evidenceOwnerUserId?: string | null;
  /** Phase 32.6.1 — bounded JSON blob the worker writes after a
   *  PackageGateDeniedError. Shape:
   *    { blocked: true, outcome: string, reason: string,
   *      label: string, blockedAtUtc: ISO8601 }
   *  When null/undefined or `blocked !== true`, the package is
   *  treated as "not blocked" (either pending, available, or
   *  unavailable for personal workspace). */
  evidenceVerificationPackageMetadata?: prismaPkg.Prisma.JsonValue | null;
}): Promise<EvidenceArtifactStatus> {
  const { evidenceId } = params;
  const [latestReport, latestPackage, latestRequest, eligibility] =
    await Promise.all([
      prisma.report.findFirst({
        where: { evidenceId },
        orderBy: { version: "desc" },
        select: {
          version: true,
          generatedAtUtc: true,
          verificationPackageVersion: true,
          reviewerSummaryVersion: true,
          // Phase A2 — explicit PDF signature columns.
          pdfSignatureStatus: true,
          pdfSignedAtUtc: true,
          pdfSignerKeyId: true,
          pdfSigningWarning: true,
        },
      }),
      prisma.verificationPackage.findFirst({
        where: { evidenceId },
        orderBy: { version: "desc" },
        select: {
          version: true,
          generatedAtUtc: true,
          packageType: true,
        },
      }),
      /*
       * AXIS 2. The most recent durable generation request for this record.
       *
       * `ReportGenerationRequest` carries the only real execution state the
       * platform has, and until now NOTHING outside the worker read it: a
       * customer could not learn that their report had failed, only that it
       * was "pending" forever. The projection below is deliberately narrower
       * than the row (see `projectReportRequestState`).
       */
      prisma.reportGenerationRequest
        .findFirst({
          where: { evidenceId },
          orderBy: { createdAtUtc: "desc" },
          select: {
            state: true,
            terminalReasonCode: true,
            attemptCount: true,
            createdAtUtc: true,
            completedAtUtc: true,
          },
        })
        .catch(() => null),
      /*
       * AXIS 1. Plan AND this record's own funding, through the one authority.
       * Degrades to fail-closed FREE rather than throwing — an artifact status
       * read must not 500 because a commercial lookup was slow.
       */
      params.evidenceOwnerUserId
        ? resolveEvidenceOutputEligibility({
            evidenceId,
            ownerUserId: params.evidenceOwnerUserId,
            teamId: params.evidenceTeamId,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

  const finalized =
    params.evidenceStatus === prismaPkg.EvidenceStatus.SIGNED ||
    params.evidenceStatus === prismaPkg.EvidenceStatus.REPORTED;

  /*
   * P1-3 CLOSURE (2026-09-10) — THE RECORD AXIS.
   *
   * `finalized` alone folded a terminal integrity failure into "not finalized
   * yet", and the derivation then folded THAT into `NOT_INCLUDED`, which every
   * surface renders with plan copy. A `FAILED_HASH_MISMATCH` record was
   * therefore told its billing plan was the reason it had no report.
   *
   * The three record conditions are named here, once, from the status the
   * caller already holds.
   */
  const recordApplicability: OutputRecordApplicability =
    resolveOutputRecordApplicability(params.evidenceStatus);

  const reportEligibility: OutputCommercialEligibility =
    eligibility?.reportEligibility ?? "ELIGIBLE";
  const packageEligibility: OutputCommercialEligibility =
    eligibility?.packageEligibility ?? "ELIGIBLE";
  const ineligibilityReason: OutputIneligibilityReason | null =
    eligibility?.ineligibilityReason ?? null;

  /*
   * `eligibility === null` means the caller passed no owner, so axis 1 is
   * UNKNOWN rather than NOT_INCLUDED. Assuming ELIGIBLE there preserves the
   * previous behaviour exactly for any un-migrated caller — it can still say
   * "pending" — while every migrated caller gets the truth. Assuming
   * NOT_INCLUDED would have been the fail-closed choice for an authorization
   * question; this is a DISPLAY question, and hiding a report a customer is
   * entitled to is the worse error.
   */

  const generation: OutputGenerationState = latestRequest
    ? projectReportRequestState(latestRequest.state as PersistedReportRequestState)
    : "NOT_REQUESTED";
  const terminalReasonClass: OutputTerminalReasonClass | null =
    generation === "TERMINAL_FAILURE"
      ? classifyTerminalReason(latestRequest?.terminalReasonCode ?? null)
      : null;

  const reportAvailability: OutputArtifactAvailability = latestReport
    ? "READY"
    : "NO_ARTIFACT";
  const packageAvailability: OutputArtifactAvailability = latestPackage
    ? "READY"
    : "NO_ARTIFACT";

  // Phase 32.6.6 — personal-workspace evidence is now first-class.
  // The worker generates a PERSONAL BASIC package (no governance
  // gate); the personal-workspace `unavailable` derivation is
  // therefore retired.
  //
  // COMMERCIAL CLOSURE (2026-09-08) — `unavailable` is no longer always false.
  // It now carries the one thing it was reserved for: an output the plan (and
  // this record's funding) genuinely exclude.
  const packageUnavailableForPersonalWorkspace = false;

  // Phase 32.6.1 — read the bounded gate-denial metadata the worker
  // persists after PackageGateDeniedError. Distinguishes "blocked by
  // governance" from "still pending" so the frontend doesn't poll
  // forever for a package that will only become available when the
  // governance condition resolves.
  const blockedMeta = readBlockedMetadata(
    params.evidenceVerificationPackageMetadata ?? null,
  );
  const packageBlocked = finalized && !latestPackage && blockedMeta !== null;

  /*
   * THE DERIVED STATES. One call each, from the shared machine.
   *
   * The governance block is folded into axis 2 for the package, because from
   * the customer's side "a policy refused this" and "the pipeline refused this"
   * are the same kind of fact — something stopped it — and the reason is what
   * differs. The report has no equivalent metadata blob.
   */
  const reportAxes = {
    eligibility: reportEligibility,
    generation,
    availability: reportAvailability,
    record: recordApplicability,
  } as const;
  const reportOutput: EvidenceOutputProjection = {
    eligibility: reportEligibility,
    ineligibilityReason:
      reportEligibility === "NOT_INCLUDED" ? ineligibilityReason : null,
    notApplicableReason: outputNotApplicableReason(reportAxes),
    generation,
    terminalReasonClass,
    terminalReasonCode:
      generation === "TERMINAL_FAILURE"
        ? (latestRequest?.terminalReasonCode ?? null)
        : null,
    attemptCount: latestRequest?.attemptCount ?? null,
    requestedAtUtc: latestRequest?.createdAtUtc?.toISOString() ?? null,
    completedAtUtc: latestRequest?.completedAtUtc?.toISOString() ?? null,
    availability: reportAvailability,
    state: deriveEvidenceOutputState(reportAxes),
    action: "NONE",
    actionUnavailableReason: null,
  };
  /*
   * P2-1 CLOSURE (2026-09-10) — A RECORD WITH NO WORKSPACE CARRIES NO VERB.
   *
   * The generation writer refuses a record whose workspace is null, because a
   * request that cannot be scoped must not exist. Legacy personal rows written
   * before the workspace backfill are exactly that shape AND are listed, so
   * the verb was offered and the click was answered with "This evidence record
   * is not available."
   *
   * Withdrawn here, once, for both outputs — and the STATE is untouched, so an
   * existing artifact on such a record stays READY and stays downloadable.
   */
  const workspaceResolved = Boolean(params.evidenceTeamId);

  {
    const offered = resolveOfferedOutputAction({
      action: outputActionFor({
        state: reportOutput.state,
        eligibility: reportEligibility,
        terminalReasonClass,
      }),
      workspaceResolved,
    });
    reportOutput.action = offered.action;
    reportOutput.actionUnavailableReason = offered.actionUnavailableReason;
  }

  const packageGeneration: OutputGenerationState = packageBlocked
    ? "BLOCKED"
    : generation;
  const packageAxes = {
    eligibility: packageEligibility,
    generation: packageGeneration,
    availability: packageAvailability,
    record: recordApplicability,
  } as const;
  const packageOutput: EvidenceOutputProjection = {
    eligibility: packageEligibility,
    ineligibilityReason:
      packageEligibility === "NOT_INCLUDED" ? ineligibilityReason : null,
    notApplicableReason: outputNotApplicableReason(packageAxes),
    generation: packageGeneration,
    terminalReasonClass:
      packageGeneration === "TERMINAL_FAILURE" ? terminalReasonClass : null,
    terminalReasonCode:
      packageGeneration === "TERMINAL_FAILURE"
        ? (latestRequest?.terminalReasonCode ?? null)
        : null,
    attemptCount: latestRequest?.attemptCount ?? null,
    requestedAtUtc: latestRequest?.createdAtUtc?.toISOString() ?? null,
    completedAtUtc: latestRequest?.completedAtUtc?.toISOString() ?? null,
    availability: packageAvailability,
    state: deriveEvidenceOutputState(packageAxes),
    action: "NONE",
    actionUnavailableReason: null,
  };
  {
    const offered = resolveOfferedOutputAction({
      action: outputActionFor({
        state: packageOutput.state,
        eligibility: packageEligibility,
        terminalReasonClass: packageOutput.terminalReasonClass,
      }),
      workspaceResolved,
    });
    packageOutput.action = offered.action;
    packageOutput.actionUnavailableReason = offered.actionUnavailableReason;
  }

  /*
   * THE LEGACY BOOLEANS, KEPT IN AGREEMENT WITH THE STATE.
   *
   * `pending` used to be `finalized && !artifact` — pure absence. It is now
   * derived from the state, so it means what the word means: work is expected
   * or under way. A record the plan excludes is `unavailable`, and a record
   * whose generation terminally failed is neither pending nor available.
   */
  const reportPending =
    reportOutput.state === "QUEUED" || reportOutput.state === "GENERATING";
  // The report's legacy union carries no `unavailable` member; its exclusion
  // reason travels on `outputs.report`, which is what consumers now read.

  const packagePending =
    packageOutput.state === "QUEUED" || packageOutput.state === "GENERATING";
  const packageNotIncluded = packageOutput.state === "NOT_INCLUDED";

  // Phase A2 — project the PDF signature block. When the Report row
  // pre-dates A2, `pdfSignatureStatus` is NULL — we surface this as
  // `SIGNING_UNAVAILABLE` with the canonical operator warning copy
  // so the frontend never accidentally renders a signed badge on a
  // legacy row.
  const pdfSignature: ReportPdfSignatureProjection | null = latestReport
    ? (() => {
        const status: PdfSignatureStatus =
          normalizePdfSignatureStatus(latestReport.pdfSignatureStatus) ??
          "SIGNING_UNAVAILABLE";
        return {
          status,
          signedAtUtc:
            status === "SIGNED" && latestReport.pdfSignedAtUtc
              ? latestReport.pdfSignedAtUtc.toISOString()
              : null,
          signerKeyId:
            status === "SIGNED" ? (latestReport.pdfSignerKeyId ?? null) : null,
          warning: resolveWarningCopy(
            status,
            latestReport.pdfSigningWarning ?? null,
          ),
        };
      })()
    : null;

  // Phase A2 — manifest signature block. Today the worker always
  // signs the Verification Package manifest with Ed25519 (the
  // `MANIFEST.json.sig` artifact
  // bundle); the package is SIGNED whenever it exists. The bounded
  // union reserves UNSIGNED for a future opt-out path so we don't
  // ship a status the contract cannot describe.
  //
  // ---------------------------------------------------------------------
  // RELIABILITY CLOSURE (2026-09-09) — THE KEY ID IS NO LONGER GUESSED
  // ---------------------------------------------------------------------
  // `signerKeyId` was read from `process.env.PACKAGE_SIGNING_KEY_ID` — the
  // key THIS API HOST would sign with today, not the key that signed THIS
  // package. Those are the same value right up until a rotation, after which
  // every historical package is reported as signed by a key that did not
  // exist when it was built. On an integrity surface that is not a stale
  // field, it is a false provenance claim.
  //
  // Compare the report block a few lines above, which reads
  // `latestReport.pdfSignerKeyId` — the value persisted with the artifact.
  // That is the correct shape, and VerificationPackage has no equivalent
  // column, so there is nothing here to read.
  //
  // Until that column exists the honest answer is null: the package IS signed
  // (the status is a fact about the bytes the worker always writes), and this
  // API cannot say by which key. The authoritative answer already travels
  // inside the artifact, in `MANIFEST.json.sig`, which is where a verifier
  // looks anyway. No UI reads this field; both consumers read `.status`.
  //
  // DEFERRED, DELIBERATELY: persisting a signer key id on VerificationPackage
  // is a schema change, and inventing one now would either backfill historical
  // rows with today's key — reintroducing the exact false claim — or ship a
  // column that is null for every existing package. Either belongs to a change
  // that can migrate and backfill honestly, not to this one.
  const manifestSignature: VerificationPackageSignatureProjection | null =
    latestPackage
      ? {
          status: "SIGNED" as VerificationPackageSignatureStatus,
          signerKeyId: null,
        }
      : null;

  return {
    evidenceId,
    status: params.evidenceStatus,
    finalized,
    outputs: {
      report: reportOutput,
      verificationPackage: packageOutput,
    },
    report: latestReport
      ? {
          available: true,
          version: latestReport.version,
          generatedAtUtc: latestReport.generatedAtUtc.toISOString(),
          reviewerSummaryVersion: latestReport.reviewerSummaryVersion ?? null,
          verificationPackageVersion:
            latestReport.verificationPackageVersion ?? null,
          pending: false,
          pdfSignature: pdfSignature!,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          reviewerSummaryVersion: null,
          verificationPackageVersion: null,
          pending: reportPending,
          pdfSignature: null,
        },
    verificationPackage: latestPackage
      ? {
          available: true,
          version: latestPackage.version,
          generatedAtUtc: latestPackage.generatedAtUtc.toISOString(),
          packageType: latestPackage.packageType ?? null,
          pending: false,
          unavailable: false,
          unavailableReason: null,
          blocked: false,
          blockedOutcome: null,
          blockedReason: null,
          blockedAtUtc: null,
          manifestSignature: manifestSignature!,
        }
      : {
          available: false,
          version: null,
          generatedAtUtc: null,
          packageType: null,
          pending: packagePending,
          // Phase 32.6.6 retired the personal-workspace exclusion, and the
          // COMMERCIAL CLOSURE gave this field the meaning it was reserved
          // for: an output the plan and this record's funding exclude.
          unavailable: packageNotIncluded || packageUnavailableForPersonalWorkspace,
          unavailableReason: packageNotIncluded ? ineligibilityReason : null,
          blocked: packageBlocked,
          blockedOutcome: packageBlocked ? blockedMeta!.outcome : null,
          blockedReason: packageBlocked ? blockedMeta!.reason : null,
          blockedAtUtc: packageBlocked ? blockedMeta!.blockedAtUtc : null,
          manifestSignature: null,
        },
  };
}

/**
 * Phase 32.6.1 — bounded reader for the gate-denial JSON the worker
 * writes after a PackageGateDeniedError. Returns null when the blob
 * is absent / malformed / not a denial record.
 *
 * Defensive: NEVER throws. The shape is purely informational; if
 * fields are missing, return null and the caller treats the package
 * as not-blocked.
 */
function readBlockedMetadata(
  raw: prismaPkg.Prisma.JsonValue | null,
): { outcome: string; reason: string; label: string | null; blockedAtUtc: string | null } | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.blocked !== true) return null;
  const outcome = typeof obj.outcome === "string" ? obj.outcome : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  if (!outcome || !reason) return null;
  return {
    outcome,
    reason,
    label: typeof obj.label === "string" ? obj.label : null,
    blockedAtUtc:
      typeof obj.blockedAtUtc === "string" ? obj.blockedAtUtc : null,
  };
}
