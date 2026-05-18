"use client";

/**
 * Phase 6 — Source card + minimal review controls for evidence created
 * via external intake.
 *
 * Rendered on the authenticated evidence detail page. Returns null when the
 * evidence did not come from external intake (the common case), so the
 * existing evidence page is unaffected for every authenticated capture
 * record.
 *
 * Privacy contract:
 *   - The backend route /v1/evidence/:id/external-intake-summary returns
 *     only authenticated-safe metadata. No token, no token hash, no
 *     contributor IP, no raw user agent. See
 *     services/api/src/services/external-intake-source-summary.service.ts.
 *   - The card itself never reads from any public endpoint and never
 *     surfaces anything beyond what the authenticated summary returns.
 *   - Review controls call the EXISTING /v1/evidence/:id/reviewer-workflow
 *     PATCH endpoint (built before Phase 6). No new review surface was
 *     created; this UI is a thin client over what's already there.
 *
 * Language:
 *   - Reviewer status labels use legally-safe wording (e.g. "Accepted for
 *     internal review", "Needs additional context") rather than truth
 *     claims.
 */

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";

type Summary = {
  source: "external_intake";
  intakeMode: string;
  isAnonymous: boolean;
  workflowTemplateSlug: string;
  workflowTemplateName: string;
  workflowTemplateVersion: number;
  caseId: string | null;
  link: {
    id: string;
    status: string;
    expiresAtUtc: string;
    usedCount: number;
    maxUses: number;
    createdAt: string;
    createdByUserId: string;
    recipientLabel: string | null;
    revokedAtUtc: string | null;
  };
  session: {
    id: string;
    status: string;
    submitterDisplayName: string | null;
    submitterEmail: string | null;
    pseudonym: string | null;
    openedAtUtc: string | null;
    uploadStartedAtUtc: string | null;
    uploadCompletedAtUtc: string | null;
    submittedAtUtc: string | null;
    consentAcceptedAtUtc: string | null;
    consentPolicyVersion: string | null;
  };
};

type ReviewSummary = {
  status?: string | null;
  priority?: string | null;
  assignedTo?: { id?: string; displayName?: string | null } | null;
  note?: string | null;
  updatedAt?: string | null;
};

// Legally-safe status labels. The on-the-wire status comes from the
// existing EvidenceReviewWorkflowStatus enum; we only relabel for display.
const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: "Needs review",
  IN_REVIEW: "In review",
  NEEDS_INFO: "Needs additional context",
  READY_FOR_EXTERNAL_REVIEW: "Ready for external review",
  APPROVED_INTERNAL: "Accepted for internal review",
  ESCALATED: "Escalated for further review",
  CLOSED: "Not accepted",
};

const ACTIONABLE_STATUSES = [
  "NOT_STARTED",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED_INTERNAL",
  "CLOSED",
];

export default function ExternalIntakeSourceCard({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const [summary, setSummary] = useState<Summary | null | undefined>(undefined);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/external-intake-summary`, {
      method: "GET",
    })
      .then((res: { summary: Summary | null }) => {
        if (cancelled) return;
        setSummary(res?.summary ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  useEffect(() => {
    if (summary === undefined || summary === null) return;
    let cancelled = false;
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`, {
      method: "GET",
    })
      .then((res: ReviewSummary) => {
        if (cancelled) return;
        setReview(res ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setReview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, summary === null || summary === undefined]);

  const currentStatusLabel = useMemo(() => {
    const status = review?.status ?? "NOT_STARTED";
    return STATUS_LABEL[status] ?? status;
  }, [review?.status]);

  async function patchReviewStatus(nextStatus: string, note?: string) {
    setReviewBusy(true);
    setReviewError(null);
    try {
      const res: ReviewSummary = await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: nextStatus,
            note: note ?? null,
          }),
        },
      );
      setReview(res);
    } catch (err) {
      const e = err as { message?: string };
      setReviewError(e?.message ?? "Could not update review status.");
    } finally {
      setReviewBusy(false);
    }
  }

  // Render nothing while still loading or when the evidence is not external.
  if (summary === undefined) return null;
  if (summary === null) return null;

  return (
    <section style={cardWrapperStyle} aria-label="External intake source">
      <header style={cardHeaderStyle}>
        <div>
          <p style={mutedStyle}>Source</p>
          <h3 style={titleStyle}>External intake</h3>
        </div>
        <span style={modeBadgeStyle}>
          {summary.intakeMode.replace("EXTERNAL_", "").replace(/_/g, " ").toLowerCase()}
        </span>
      </header>

      <dl style={detailGridStyle}>
        <Detail label="Workflow">
          {summary.workflowTemplateName} (v{summary.workflowTemplateVersion})
        </Detail>
        <Detail label="Submitted at">
          {summary.session.submittedAtUtc
            ? new Date(summary.session.submittedAtUtc).toLocaleString()
            : "—"}
        </Detail>
        <Detail label="Contributor">
          {summary.isAnonymous
            ? summary.session.pseudonym
              ? `Pseudonym: ${summary.session.pseudonym}`
              : "Anonymous"
            : summary.session.submitterEmail ??
              summary.session.submitterDisplayName ??
              "Not provided"}
        </Detail>
        <Detail label="Consent">
          {summary.session.consentAcceptedAtUtc
            ? `Accepted ${new Date(summary.session.consentAcceptedAtUtc).toLocaleString()}` +
              (summary.session.consentPolicyVersion
                ? ` · v${summary.session.consentPolicyVersion}`
                : "")
            : "Not recorded"}
        </Detail>
        <Detail label="Session status">{summary.session.status}</Detail>
        <Detail label="Link status">
          {summary.link.status} (used {summary.link.usedCount}/{summary.link.maxUses})
        </Detail>
        {summary.caseId ? (
          <Detail label="Case / matter">{summary.caseId}</Detail>
        ) : null}
      </dl>

      <div style={reviewSectionStyle}>
        <header style={{ marginBottom: 8 }}>
          <p style={mutedStyle}>Reviewer status</p>
          <h4 style={subtitleStyle}>{currentStatusLabel}</h4>
        </header>
        {reviewError ? <div style={errorBoxStyle}>{reviewError}</div> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ACTIONABLE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              style={
                review?.status === s
                  ? { ...statusButtonStyle, ...statusButtonActiveStyle }
                  : statusButtonStyle
              }
              disabled={reviewBusy}
              onClick={() => patchReviewStatus(s)}
            >
              {STATUS_LABEL[s] ?? s}
            </button>
          ))}
        </div>
        <p style={{ ...mutedStyle, marginTop: 12, fontSize: 12 }}>
          Reviewer decisions are workflow status updates. They do not assert
          authenticity, legal admissibility, or factual truth.
        </p>
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt style={detailLabelStyle}>{label}</dt>
      <dd style={detailValueStyle}>{children}</dd>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles — self-contained so this component does not depend on the existing
// evidence-detail.css. A future polish phase can move to the design system.
// -----------------------------------------------------------------------------

const cardWrapperStyle: React.CSSProperties = {
  marginTop: 24,
  marginBottom: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: 16,
  gap: 12,
};
const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
  color: "#0f172a",
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  margin: 0,
  color: "#0f172a",
};
const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#64748b",
  margin: 0,
};
const modeBadgeStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e40af",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};
const detailGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  margin: 0,
};
const detailLabelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#64748b",
  marginBottom: 2,
};
const detailValueStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#0f172a",
  margin: 0,
};
const reviewSectionStyle: React.CSSProperties = {
  marginTop: 20,
  paddingTop: 16,
  borderTop: "1px solid #e2e8f0",
};
const statusButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  cursor: "pointer",
  color: "#0f172a",
};
const statusButtonActiveStyle: React.CSSProperties = {
  background: "#0f172a",
  borderColor: "#0f172a",
  color: "#fff",
  fontWeight: 600,
};
const errorBoxStyle: React.CSSProperties = {
  marginBottom: 8,
  padding: 8,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 13,
};
