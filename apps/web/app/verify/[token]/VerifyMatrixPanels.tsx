"use client";

/**
 * THE VERIFICATION MATRIX on the Public Verify page (2026-10-08).
 *
 * The page states a record signal by signal: the bounded matrix summary, the
 * fixed limitation, and one row per signal with exactly one status word
 * (VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE). There is no
 * score, weighted point, overall verdict, reliance level or confidence label.
 *
 * The API sends the matrix; an API deployed before it does not (the web is
 * deployed first), so resolveVerifyMatrix derives the signal rows from the
 * trust decision — already read through readStoredTrustDecision, which strips
 * any score or verdict an old response carries.
 */
import {
  buildVerificationMatrix,
  getTrustDecisionPresentationTone,
  VERIFICATION_LIMITATION,
  verificationMatrixSummary,
  type VerificationMatrix,
  type VerificationMatrixRow,
  type VerificationStatus,
} from "@proovra/shared";

import { VERIFY_BRAND, VERIFY_TYPO } from "./_verify-theme";
import type { VerifyTrustDecision } from "./_verify-types";

/**
 * The matrix keys a trust decision's own signals project to. When the API
 * predates the verification matrix (the web deploys first), the page states
 * exactly these rows, read from the decision's signals — never identity,
 * capture or package rows it has no facts for.
 */
const SIGNAL_MATRIX_KEYS: ReadonlyArray<VerificationMatrixRow["key"]> = [
  "file_integrity",
  "record_signature",
  "custody_chain",
  "tsa_token",
  "ots_anchoring",
  "storage_protection",
];

/** Rows whose FAILED status means the preserved bytes need review. */
const INTEGRITY_CRITICAL_MATRIX_KEYS: ReadonlyArray<VerificationMatrixRow["key"]> = [
  "file_integrity",
  "record_signature",
  "custody_chain",
];

/**
 * THE matrix this page states. The API's matrix when it sent one; otherwise
 * the signal rows derived from the trust decision (readStoredTrustDecision
 * has already stripped any score, verdict or reliance an old API sent).
 */
export function resolveVerifyMatrix(
  serverMatrix: VerificationMatrix | null,
  decision: VerifyTrustDecision
): VerificationMatrix {
  if (serverMatrix) return serverMatrix;
  const full = buildVerificationMatrix({
    signals: decision.signals,
    identity: null,
    acquisitionMode: null,
    packageSeal: { kind: "NONE" },
    publication: { kind: "THIS_PAGE" },
  });
  const rows = full.rows.filter((row) => SIGNAL_MATRIX_KEYS.includes(row.key));
  return {
    ...full,
    rows,
    summary: verificationMatrixSummary(rows),
    limitation: VERIFICATION_LIMITATION,
  };
}

export function matrixRequiresIntegrityReview(
  matrix: VerificationMatrix,
  decision: VerifyTrustDecision
): boolean {
  return (
    decision.integrityReviewRequired === true ||
    matrix.rows.some(
      (row) => row.status === "FAILED" && INTEGRITY_CRITICAL_MATRIX_KEYS.includes(row.key)
    )
  );
}

/** The summary without the fixed limitation (stated on its own line). */
export function matrixSummarySentence(matrix: VerificationMatrix): string {
  const summary = matrix.summary.trim();
  const limitation = matrix.limitation.trim();
  return limitation && summary.endsWith(limitation)
    ? summary.slice(0, summary.length - limitation.length).trim()
    : summary;
}

function verificationStatusColor(status: VerificationStatus): string {
  switch (status) {
    case "VERIFIED":
      return VERIFY_BRAND.success;
    case "FAILED":
      return VERIFY_BRAND.danger;
    case "NOT_CHECKED":
      return VERIFY_BRAND.warning;
    default:
      return VERIFY_BRAND.accent;
  }
}

/**
 * THE headline of the page (2026-10-08): the bounded matrix summary, the fixed
 * limitation, the anchoring posture and the reviewer action. There is no
 * score, verdict, reliance level or confidence label — the record is stated
 * signal by signal in the matrix below.
 */
export function VerificationSummaryCard({
  matrix,
  decision,
}: {
  matrix: VerificationMatrix;
  decision: VerifyTrustDecision;
}) {
  const decisionTone = getTrustDecisionPresentationTone(decision);
  const palette =
    decisionTone === "success"
      ? {
          rail: VERIFY_BRAND.success,
          bg: "linear-gradient(180deg, rgba(33,117,93,0.10), rgba(255,255,255,0.78))",
          border: "rgba(33,117,93,0.30)",
        }
      : decisionTone === "danger"
        ? {
            rail: VERIFY_BRAND.danger,
            bg: "linear-gradient(180deg, rgba(181,71,56,0.10), rgba(255,255,255,0.78))",
            border: "rgba(181,71,56,0.30)",
          }
        : {
            rail: VERIFY_BRAND.warning,
            bg: "linear-gradient(180deg, rgba(138,106,47,0.11), rgba(255,255,255,0.78))",
            border: "rgba(138,106,47,0.30)",
          };

  return (
    <div
      data-testid="verify-matrix-summary-card"
      style={{
        border: `1px solid ${palette.border}`,
        borderLeft: `7px solid ${palette.rail}`,
        background: palette.bg,
        borderRadius: 24,
        padding: 24,
        display: "grid",
        gap: 18,
        boxShadow: "0 18px 42px rgba(16,32,29,0.08)",
      }}
    >
      <div>
        <div style={{ ...VERIFY_TYPO.kicker, marginBottom: 8 }}>
          Verification Summary
        </div>

        <div
          data-testid="verify-matrix-summary"
          style={{
            fontSize: "clamp(1.15rem, 1.8vw, 1.55rem)",
            lineHeight: 1.25,
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
          style={{
            ...VERIFY_TYPO.body,
            fontSize: 14.5,
            color: VERIFY_BRAND.ink,
            maxWidth: 900,
          }}
        >
          {matrix.limitation}
        </div>
      </div>

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
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
          Reviewer Action
        </div>
        <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink }}>
          Publication posture:{" "}
          {decision.anchoringStatusLabel || "Bitcoin anchoring status requires review"}.
        </div>
        <div
          style={{
            ...VERIFY_TYPO.small,
            color: VERIFY_BRAND.ink,
            fontWeight: 850,
          }}
        >
          {decision.reviewerAction}
        </div>
      </div>
    </div>
  );
}

/**
 * The verification matrix: one row per signal, each with its label, its one
 * canonical status word (VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE |
 * UNAVAILABLE) and its factual statement.
 */
export function VerificationMatrixGrid({
  rows,
}: {
  rows: ReadonlyArray<VerificationMatrixRow>;
}) {
  return (
    <div
      data-testid="verify-matrix"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 14,
      }}
    >
      {rows.map((row) => {
        const color = verificationStatusColor(row.status);

        return (
          <div
            key={row.key}
            data-testid={`verify-matrix-row-${row.key}`}
            data-status={row.status}
            style={{
              border: `1px solid ${VERIFY_BRAND.line}`,
              borderLeft: `5px solid ${color}`,
              background: "rgba(255,255,255,0.64)",
              borderRadius: 18,
              padding: 16,
              display: "grid",
              gap: 9,
              alignContent: "start",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
                {row.label}
              </div>

              <div
                data-testid={`verify-matrix-status-${row.key}`}
                style={{
                  color,
                  fontSize: 12,
                  fontWeight: 950,
                  whiteSpace: "nowrap",
                  letterSpacing: "0.03em",
                }}
              >
                {row.status}
              </div>
            </div>

            <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
              {row.statement}
            </div>
          </div>
        );
      })}
    </div>
  );
}
