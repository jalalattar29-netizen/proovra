"use client";

/**
 * THE VERIFICATION MATRIX on the Public Verify page (2026-10-08; converged
 * 2026-10-18).
 *
 * The page states a record signal by signal: the bounded matrix summary, the
 * fixed limitation, and one row per signal with exactly one status word
 * (VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE), an icon
 * beside it, the row's qualifiers and its statement. There is no score,
 * weighted point, overall verdict, reliance level or confidence label.
 *
 * The API's matrix is the ONLY source: when a response carries none, the page
 * says "Verification matrix unavailable" — it never rebuilds rows on the client.
 */
import {
  getTrustDecisionPresentationTone,
  otsVerificationKeyOfState,
  parseOtsState,
  parseOtsVerificationKey,
  parseVerificationQualifiers,
  presentOtsAnchoring,
  type OtsStateTone,
  type OtsVerificationKey,
  type VerificationMatrix,
  type VerificationMatrixRow,
  type VerificationStatus,
} from "@proovra/shared";

import { formatDateTime } from "../../../components/verify-v2/_helpers";
import { VERIFY_BRAND, VERIFY_TYPO } from "./_verify-theme";
import type { VerifyTrustDecision } from "./_verify-types";
import { QualifierList, StatusMark, statusColor } from "./VerifyRecordSections";

/** Shown wherever a response carried no verification matrix. */
export const VERIFY_MATRIX_UNAVAILABLE = "Verification matrix unavailable";

/** The summary without the fixed limitation (stated on its own line). */
export function matrixSummarySentence(matrix: VerificationMatrix): string {
  const summary = matrix.summary.trim();
  const limitation = matrix.limitation.trim();
  return limitation && summary.endsWith(limitation)
    ? summary.slice(0, summary.length - limitation.length).trim()
    : summary;
}

/**
 * The words above the verification matrix (2026-10-15). Bitcoin anchoring is
 * "Verified" only for an independent check against the Bitcoin main chain; a
 * Bitcoin attestation the proof merely names is "Not checked".
 */
export const VERIFY_MATRIX_INTRO =
  "Each signal is stated in exactly one status: Verified, Failed, Not checked, Not applicable or Unavailable. " +
  "A signal marked “Not checked” was not independently verified. Bitcoin anchoring is Verified only when PROOVRA " +
  "independently checked the OpenTimestamps proof against the Bitcoin main chain; a Bitcoin attestation that was " +
  "recorded but not checked reads “Attestation recorded” and is Not checked. A failed or unchecked timestamp or " +
  "Bitcoin attestation does not by itself invalidate core hashes, signatures, custody records, or preserved originals.";

/**
 * The Bitcoin anchoring row speaks its own vocabulary (2026-10-15): the
 * server's verification key (`otsVerification`, coherent with `otsState` and
 * the row's matrix status) in one word and tone. Only CHAIN_VERIFIED is a
 * success (with ✓) and only on a VERIFIED row; FAILED / CHAIN_FAILED are
 * danger; every other key — including an attestation recorded but never
 * checked against the chain — is neutral. Other rows: null.
 */
export function otsMatrixRowPresentation(
  row: Pick<VerificationMatrixRow, "key" | "otsState" | "otsVerification"> & { status?: VerificationStatus }
): { word: string; badge: string; tone: OtsStateTone; verification: OtsVerificationKey } | null {
  if (row.key !== "ots_anchoring") return null;
  const state = parseOtsState(row.otsState);
  // presentOtsAnchoring keeps a verification key only when it is coherent
  // with the lifecycle state; a CHAIN_VERIFIED claim on a row whose matrix
  // status is not VERIFIED is read as an unchecked attestation.
  const claimed = parseOtsVerificationKey(row.otsVerification);
  const believed =
    claimed === "CHAIN_VERIFIED" && row.status !== undefined && row.status !== "VERIFIED" ? "ATTESTATION_RECORDED" : claimed;
  const p = presentOtsAnchoring({ state, verification: believed ?? otsVerificationKeyOfState(state) });
  return {
    word: p.status,
    badge: p.tone === "success" ? `✓ ${p.status}` : p.status,
    tone: p.tone,
    verification: p.verification,
  };
}

/**
 * THE headline of the page (2026-10-08): the bounded matrix summary, the fixed
 * limitation (the page's ONE legal boundary) and the reviewer action — all as
 * the API sent them. There is no score, verdict, reliance level or confidence
 * label, and no client fallback: without the API's matrix the card says so.
 */
export function VerificationSummaryCard({
  matrix,
  decision,
}: {
  matrix: VerificationMatrix | null;
  decision: VerifyTrustDecision | null;
}) {
  const decisionTone = decision ? getTrustDecisionPresentationTone(decision) : "neutral";
  const rail =
    decisionTone === "success" ? VERIFY_BRAND.success : decisionTone === "danger" ? VERIFY_BRAND.danger : VERIFY_BRAND.warning;

  return (
    <section
      aria-labelledby="verify-summary-heading"
      data-testid="verify-matrix-summary-card"
      data-verify-card
      style={{
        border: `1px solid ${VERIFY_BRAND.line}`,
        borderLeft: `7px solid ${rail}`,
        background: "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.80))",
        borderRadius: 24,
        padding: "clamp(16px, 4vw, 24px)",
        display: "grid",
        gap: 16,
        minWidth: 0,
      }}
    >
      <div>
        <h2 id="verify-summary-heading" style={{ ...VERIFY_TYPO.kicker, margin: "0 0 8px" }}>
          Verification Summary
        </h2>
        {matrix ? (
          <>
            <div
              data-testid="verify-matrix-summary"
              style={{
                fontSize: "clamp(1.1rem, 1.8vw, 1.5rem)",
                lineHeight: 1.3,
                fontWeight: 900,
                letterSpacing: "-0.02em",
                color: VERIFY_BRAND.ink,
                marginBottom: 10,
                maxWidth: 960,
              }}
            >
              {matrixSummarySentence(matrix)}
            </div>
            <div
              data-testid="verify-matrix-limitation"
              data-verify-legal-boundary
              style={{ ...VERIFY_TYPO.body, fontSize: 14.5, color: VERIFY_BRAND.ink, maxWidth: 900 }}
            >
              {matrix.limitation}
            </div>
          </>
        ) : (
          <div data-testid="verify-matrix-unavailable" style={{ ...VERIFY_TYPO.value, fontSize: 16 }}>
            {VERIFY_MATRIX_UNAVAILABLE}
          </div>
        )}
      </div>

      {decision?.reviewerAction ? (
        <div
          style={{
            border: `1px solid ${VERIFY_BRAND.softLine}`,
            background: "rgba(255,255,255,0.44)",
            borderRadius: 18,
            padding: 16,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Reviewer Action</div>
          <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink, fontWeight: 850 }}>{decision.reviewerAction}</div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The verification matrix: one row per signal, each with its label, its one
 * status (icon + the server's statusLabel, or the shared status word), the
 * row's qualifiers and its factual statement. A timestamp validated later
 * from the token retained at intake also states when it was validated.
 */
export function VerificationMatrixGrid({
  rows,
}: {
  rows: ReadonlyArray<VerificationMatrixRow>;
}) {
  return (
    <div
      data-testid="verify-matrix"
      role="list"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        gap: 14,
      }}
    >
      {rows.map((row) => {
        const qualifiers = parseVerificationQualifiers((row as { qualifiers?: unknown }).qualifiers);
        const validatedLater = row.key === "tsa_token" && qualifiers.includes("VALIDATED_FROM_RETAINED_TOKEN") && row.measuredAtUtc;
        return (
          <div
            key={row.key}
            role="listitem"
            data-testid={`verify-matrix-row-${row.key}`}
            data-status={row.status}
            style={{
              border: `1px solid ${VERIFY_BRAND.line}`,
              borderLeft: `5px solid ${statusColor(row.status)}`,
              background: "rgba(255,255,255,0.64)",
              borderRadius: 18,
              padding: 16,
              display: "grid",
              gap: 8,
              alignContent: "start",
              minWidth: 0,
              breakInside: "avoid",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div data-verify-label style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, minWidth: 0 }}>
                {row.label}
              </div>
              <StatusMark status={row.status} label={row.statusLabel ?? null} testId={`verify-matrix-status-${row.key}`} />
            </div>
            <QualifierList qualifiers={qualifiers} />
            <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink, overflowWrap: "anywhere" }}>{row.statement}</div>
            {validatedLater ? (
              <div data-verify-tsa-validated-at style={{ ...VERIFY_TYPO.small, fontSize: 12.5, color: VERIFY_BRAND.ink }}>
                Validated: {formatDateTime(row.measuredAtUtc)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
