"use client";

/**
 * Phase 9 — Workspace governance UI.
 *
 * Minimal authenticated surface for OWNER / ADMIN to configure the
 * workspace governance policy and inspect active / released legal holds.
 *
 * Privacy: this page is workspace-internal. Public verify / external
 * intake / report-v2 do not consume any of this data.
 *
 * Wording: action labels avoid truth claims ("retained", "held",
 * "policy-controlled") and never assert authenticity or legal
 * admissibility — legal hold is an internal preservation control, not
 * an evidentiary assertion.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useActiveWorkspaceId } from "../../../lib/useActiveWorkspaceId";
import {
  NoGovernanceIncidentsEmptyState,
  OperationalEmptyState,
  RuntimeStatusBanner,
} from "../../../components/operational";

// Phase 32.6.4 — bounded per-widget state machine. Replaces the
// previous `null | data` pattern where any rejected `Promise.all`
// branch left every widget stuck on "Loading…" forever.
type WidgetState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; requestId?: string };

const WIDGET_LOADING = { status: "loading" } as const;

function widgetErrorMessageFor(
  surface: "policy" | "legal-holds" | "case-legal-holds" | "retention-candidates",
  err: unknown,
): { message: string; requestId?: string } {
  const e = err as { statusCode?: number; code?: string; requestId?: string };
  // Surface bounded, enterprise-safe text. We deliberately do NOT
  // forward raw API messages — they may contain Prisma error
  // fragments, internal table names, or stack traces.
  if (e?.statusCode === 401) {
    return { message: "Sign-in required to view this section.", requestId: e.requestId };
  }
  if (e?.statusCode === 403) {
    return { message: "Permission required to view this section.", requestId: e.requestId };
  }
  if (e?.statusCode === 503 || e?.code === "governance_schema_unavailable") {
    return {
      message:
        surface === "policy"
          ? "Policy is temporarily unavailable. Operators have been notified — retry shortly."
          : surface === "legal-holds"
            ? "Legal holds are temporarily unavailable. Retry shortly."
            : surface === "case-legal-holds"
              ? "Case-level legal holds are temporarily unavailable. Retry shortly."
              : "Retention candidates are temporarily unavailable. Retry shortly.",
      requestId: e.requestId,
    };
  }
  return {
    message:
      surface === "policy"
        ? "Unable to load policy."
        : surface === "legal-holds"
          ? "Unable to load legal holds."
          : surface === "case-legal-holds"
            ? "Unable to load case-level legal holds."
            : "Unable to load retention candidates.",
    requestId: e?.requestId,
  };
}

type Policy = {
  defaultRetentionDays: number | null;
  evidenceDeletionMode: "ALLOWED" | "ADMIN_ONLY" | "DISABLED";
  requireLegalHoldApprovalForDeletion: boolean;
  requireReviewBeforeReport: boolean;
  requireReviewBeforePackage: boolean;
  requireReviewBeforePublicVerify: boolean;
  allowExternalIntake: boolean;
  allowAnonymousIntake: boolean;
  allowPublicVerify: boolean;
  allowPackageDownload: boolean;
  allowReportDownload: boolean;
  source: "workspace_row" | "default";
};

type LegalHold = {
  id: string;
  teamId: string;
  evidenceId: string;
  title: string;
  reason: string | null;
  status: "ACTIVE" | "RELEASED";
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
  releaseNote: string | null;
};

type CaseLegalHold = {
  id: string;
  teamId: string;
  caseId: string;
  title: string;
  status: "ACTIVE" | "RELEASED";
  placedByUserId: string;
  placedAtUtc: string;
  releasedByUserId: string | null;
  releasedAtUtc: string | null;
};

type RetentionCandidate = {
  id: string;
  retentionUntilUtc: string;
  retentionPolicySource: string | null;
  flaggedAtUtc: string | null;
  caseId: string | null;
  publicVerifyState: string;
};

export default function GovernancePage() {
  // Phase 32.6.4 — adopt the canonical workspace resolver. The
  // previous open-coded `/v1/users/me` call dropped the `/v1/teams`
  // fallback the topbar uses, so the page incorrectly rendered
  // "Switch to a workspace" for any user whose
  // `users.currentWorkspaceId` happened to be null even when they
  // had memberships.
  const workspace = useActiveWorkspaceId();
  const teamId =
    workspace.status === "ready" ? workspace.workspaceId : null;

  // Phase 32.6.4 — per-widget independent state. A failure on one
  // endpoint (e.g. 503 from `/policy`) MUST NOT leave the other
  // three widgets stuck on "Loading…". The previous Promise.all
  // pattern set `policy`/`holds`/`caseHolds`/`retentionCandidates`
  // to `null` and only updated `setError`, so every widget rendered
  // its "Loading…" branch forever.
  const [policyWidget, setPolicyWidget] = useState<WidgetState<Policy>>(
    WIDGET_LOADING,
  );
  const [holdsWidget, setHoldsWidget] = useState<WidgetState<LegalHold[]>>(
    WIDGET_LOADING,
  );
  const [caseHoldsWidget, setCaseHoldsWidget] = useState<
    WidgetState<CaseLegalHold[]>
  >(WIDGET_LOADING);
  const [retentionWidget, setRetentionWidget] = useState<
    WidgetState<RetentionCandidate[]>
  >(WIDGET_LOADING);

  const [busy, setBusy] = useState(false);
  const [releaseDialog, setReleaseDialog] = useState<LegalHold | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;

    // Phase 32.6.4 — each widget loads independently. We use
    // Promise.allSettled to (1) kick all four off in parallel, but
    // (2) inspect each settled result on its own so per-widget
    // state transitions correctly to either `ready` or `error`.
    const enc = encodeURIComponent(teamId);

    // Reset each widget to loading on teamId transition so a stale
    // ready/error from a prior workspace can't bleed through.
    setPolicyWidget(WIDGET_LOADING);
    setHoldsWidget(WIDGET_LOADING);
    setCaseHoldsWidget(WIDGET_LOADING);
    setRetentionWidget(WIDGET_LOADING);

    Promise.allSettled([
      apiFetch(`/v1/governance/policy?teamId=${enc}`, { method: "GET" }),
      apiFetch(`/v1/governance/legal-holds?teamId=${enc}`, { method: "GET" }),
      apiFetch(`/v1/governance/case-legal-holds?teamId=${enc}`, {
        method: "GET",
      }),
      apiFetch(`/v1/governance/retention-candidates?teamId=${enc}`, {
        method: "GET",
      }),
    ]).then((results) => {
      if (cancelled) return;

      const [policyR, holdsR, caseHoldsR, retentionR] = results;

      if (policyR.status === "fulfilled") {
        const value = policyR.value as { policy: Policy };
        setPolicyWidget({ status: "ready", data: value.policy });
      } else {
        setPolicyWidget({
          status: "error",
          ...widgetErrorMessageFor("policy", policyR.reason),
        });
      }

      if (holdsR.status === "fulfilled") {
        const value = holdsR.value as { legalHolds: LegalHold[] };
        setHoldsWidget({
          status: "ready",
          data: value.legalHolds ?? [],
        });
      } else {
        setHoldsWidget({
          status: "error",
          ...widgetErrorMessageFor("legal-holds", holdsR.reason),
        });
      }

      if (caseHoldsR.status === "fulfilled") {
        const value = caseHoldsR.value as { caseLegalHolds?: CaseLegalHold[] };
        setCaseHoldsWidget({
          status: "ready",
          data: value.caseLegalHolds ?? [],
        });
      } else {
        setCaseHoldsWidget({
          status: "error",
          ...widgetErrorMessageFor("case-legal-holds", caseHoldsR.reason),
        });
      }

      if (retentionR.status === "fulfilled") {
        const value = retentionR.value as { candidates?: RetentionCandidate[] };
        setRetentionWidget({
          status: "ready",
          data: value.candidates ?? [],
        });
      } else {
        setRetentionWidget({
          status: "error",
          ...widgetErrorMessageFor("retention-candidates", retentionR.reason),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  async function savePolicy(patch: Partial<Policy>) {
    if (!teamId) return;
    setBusy(true);
    try {
      const res: { policy: Policy } = await apiFetch(
        "/v1/governance/policy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, ...patch }),
        },
      );
      setPolicyWidget({ status: "ready", data: res.policy });
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not save policy.");
    } finally {
      setBusy(false);
    }
  }

  async function releaseHold(hold: LegalHold, note: string) {
    if (!teamId) return;
    try {
      const res: { legalHold: LegalHold } = await apiFetch(
        `/v1/governance/legal-holds/${hold.id}/release`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, releaseNote: note }),
        },
      );
      setHoldsWidget((prev) => {
        if (prev.status !== "ready") return prev;
        return {
          status: "ready",
          data: prev.data.map((h) =>
            h.id === hold.id ? res.legalHold : h,
          ),
        };
      });
      setReleaseDialog(null);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not release hold.");
    }
  }

  return (
    <main style={pageStyle}>
      {teamId ? (
        // Phase 32.7 — degradation boundary. The governance page
        // only surfaces a runtime banner when a failing subsystem
        // is in the `governance_lifecycle` domain. A degraded
        // worker / queue / search subsystem will no longer poison
        // this page.
        <RuntimeStatusBanner
          teamId={teamId}
          forDomains={["governance_lifecycle"]}
        />
      ) : null}
      <header>
        <h1 style={titleStyle}>Workspace governance</h1>
        <p style={mutedStyle}>
          Configure retention, deletion controls, intake gates, and review
          requirements. Place or release legal holds on individual evidence
          records. None of these settings assert authenticity, legal
          admissibility, or evidentiary truth — they are internal preservation
          and workflow controls.
        </p>
      </header>

      {workspace.status === "loading" ? (
        <p style={mutedStyle}>Loading workspace…</p>
      ) : workspace.status === "error" ? (
        <div style={errorBoxStyle}>{workspace.message}</div>
      ) : !teamId ? (
        <p style={mutedStyle}>Switch to a workspace to manage governance.</p>
      ) : policyWidget.status === "loading" ? (
        <p style={mutedStyle}>Loading policy…</p>
      ) : policyWidget.status === "error" ? (
        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>Policy</h2>
          <div style={errorBoxStyle}>
            {policyWidget.message}
            {policyWidget.requestId ? (
              <div style={{ ...mutedStyle, marginTop: 6 }}>
                Reference: {policyWidget.requestId}
              </div>
            ) : null}
          </div>
        </section>
      ) : (() => {
        // Phase 32.6.4 — bind a local form mutator that updates the
        // widget data slot. Keeps the existing onChange shape (the
        // form mutates `policy` locally; the network PUT happens
        // when the operator clicks Save).
        const policy = policyWidget.data;
        const setPolicy = (next: Policy) =>
          setPolicyWidget({ status: "ready", data: next });
        return (
        <section style={cardStyle}>
          <h2 style={sectionTitleStyle}>Policy</h2>
          {policy.source === "default" ? (
            <p style={mutedStyle}>
              This workspace is using the default permissive policy. Saving
              any change below creates a workspace-specific policy row.
            </p>
          ) : null}

          <Field label="Default retention (days)">
            <input
              type="number"
              min={0}
              style={inputStyle}
              value={policy.defaultRetentionDays ?? ""}
              onChange={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                setPolicy({ ...policy, defaultRetentionDays: v });
              }}
            />
          </Field>

          <Field label="Evidence deletion">
            <select
              style={inputStyle}
              value={policy.evidenceDeletionMode}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  evidenceDeletionMode: e.target.value as Policy["evidenceDeletionMode"],
                })
              }
            >
              <option value="ALLOWED">Allowed for all members</option>
              <option value="ADMIN_ONLY">Restricted to admins</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </Field>

          <Toggle
            label="Require review before report"
            value={policy.requireReviewBeforeReport}
            onChange={(v) => setPolicy({ ...policy, requireReviewBeforeReport: v })}
          />
          <Toggle
            label="Require review before package"
            value={policy.requireReviewBeforePackage}
            onChange={(v) =>
              setPolicy({ ...policy, requireReviewBeforePackage: v })
            }
          />
          <Toggle
            label="Require review before public verify"
            value={policy.requireReviewBeforePublicVerify}
            onChange={(v) =>
              setPolicy({ ...policy, requireReviewBeforePublicVerify: v })
            }
          />
          <Toggle
            label="Allow external intake"
            value={policy.allowExternalIntake}
            onChange={(v) => setPolicy({ ...policy, allowExternalIntake: v })}
          />
          <Toggle
            label="Allow anonymous intake"
            value={policy.allowAnonymousIntake}
            onChange={(v) => setPolicy({ ...policy, allowAnonymousIntake: v })}
          />
          <Toggle
            label="Allow public verify"
            value={policy.allowPublicVerify}
            onChange={(v) => setPolicy({ ...policy, allowPublicVerify: v })}
          />
          <Toggle
            label="Allow package download"
            value={policy.allowPackageDownload}
            onChange={(v) => setPolicy({ ...policy, allowPackageDownload: v })}
          />
          <Toggle
            label="Allow report download"
            value={policy.allowReportDownload}
            onChange={(v) => setPolicy({ ...policy, allowReportDownload: v })}
          />

          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy}
              onClick={() => savePolicy(policy)}
            >
              {busy ? "Saving…" : "Save policy"}
            </button>
          </div>
        </section>
        );
      })()}

      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Legal holds</h2>
        {!teamId ? null : holdsWidget.status === "loading" ? (
          <p style={mutedStyle}>Loading legal holds…</p>
        ) : holdsWidget.status === "error" ? (
          <div style={errorBoxStyle}>
            {holdsWidget.message}
            {holdsWidget.requestId ? (
              <div style={{ ...mutedStyle, marginTop: 6 }}>
                Reference: {holdsWidget.requestId}
              </div>
            ) : null}
          </div>
        ) : holdsWidget.data.length === 0 ? (
          <OperationalEmptyState
            emptyStateCode="no_evidence_legal_holds"
            kicker="Legal holds"
            title="No evidence-level legal holds placed."
            reason="No evidence record in this workspace is currently under a preservation hold. Holds are placed from the evidence detail surface and persist until an operator explicitly releases them."
            runtimeDependency="Operator action on /evidence/[id]. Hold lifecycle is captured in the internal audit trail; nothing is exposed to public verify or external intake."
            actions={[
              { label: "Open evidence list", href: "/evidence" },
              { label: "Review governance policy below", href: "#policy" },
            ]}
          />
        ) : (
          <ul style={listStyle}>
            {holdsWidget.data.map((h) => (
              <li key={h.id} style={holdRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{h.title}</div>
                  <div style={mutedStyle}>
                    Evidence {h.evidenceId.slice(0, 8)} ·{" "}
                    placed {new Date(h.placedAtUtc).toLocaleString()}
                    {h.releasedAtUtc
                      ? ` · released ${new Date(h.releasedAtUtc).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <span style={statusBadgeStyle(h.status)}>{h.status}</span>
                {h.status === "ACTIVE" ? (
                  <button
                    type="button"
                    style={secondaryButtonStyle}
                    onClick={() => setReleaseDialog(h)}
                  >
                    Release
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Phase 14 — Case-level legal holds */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Case-level legal holds</h2>
        <p style={mutedStyle}>
          Holds preserve every evidence record linked to a case. They are
          internal preservation controls — they do not claim legal
          admissibility or authenticity.
        </p>
        {!teamId ? null : caseHoldsWidget.status === "loading" ? (
          <p style={mutedStyle}>Loading case holds…</p>
        ) : caseHoldsWidget.status === "error" ? (
          <div style={errorBoxStyle}>
            {caseHoldsWidget.message}
            {caseHoldsWidget.requestId ? (
              <div style={{ ...mutedStyle, marginTop: 6 }}>
                Reference: {caseHoldsWidget.requestId}
              </div>
            ) : null}
          </div>
        ) : caseHoldsWidget.data.length === 0 ? (
          <OperationalEmptyState
            emptyStateCode="no_case_legal_holds"
            kicker="Legal holds"
            title="No case-level legal holds placed."
            reason="Case-level holds extend preservation to every evidence record linked to a case. They are placed from the case detail surface. None are currently active in this workspace."
            runtimeDependency="Operator action on /cases/[id]. Case-hold lifecycle is captured in the internal audit trail."
            actions={[{ label: "Open cases", href: "/cases" }]}
          />
        ) : (
          <ul style={listStyle}>
            {caseHoldsWidget.data.map((h) => (
              <li key={h.id} style={holdRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{h.title}</div>
                  <div style={mutedStyle}>
                    Case {h.caseId.slice(0, 8)}… · placed{" "}
                    {new Date(h.placedAtUtc).toLocaleString()}
                    {h.releasedAtUtc
                      ? ` · released ${new Date(h.releasedAtUtc).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <span style={statusBadgeStyle(h.status)}>{h.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Phase 14 — Retention candidates */}
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Retention candidates</h2>
        <p style={mutedStyle}>
          Evidence records whose retention has expired. The retention
          sweeper has FLAGGED these for operator review — Phase 14 does
          NOT auto-delete. Records on legal hold are excluded from this
          list.
        </p>
        {!teamId ? null : retentionWidget.status === "loading" ? (
          <p style={mutedStyle}>Loading retention candidates…</p>
        ) : retentionWidget.status === "error" ? (
          <div style={errorBoxStyle}>
            {retentionWidget.message}
            {retentionWidget.requestId ? (
              <div style={{ ...mutedStyle, marginTop: 6 }}>
                Reference: {retentionWidget.requestId}
              </div>
            ) : null}
          </div>
        ) : retentionWidget.data.length === 0 ? (
          <NoGovernanceIncidentsEmptyState />
        ) : (
          <ul style={listStyle}>
            {retentionWidget.data.map((c) => (
              <li key={c.id} style={holdRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    Evidence {c.id.slice(0, 8)}…
                  </div>
                  <div style={mutedStyle}>
                    expired {new Date(c.retentionUntilUtc).toLocaleString()}
                    {c.retentionPolicySource
                      ? ` · source ${c.retentionPolicySource}`
                      : ""}
                    {c.flaggedAtUtc
                      ? ` · flagged ${new Date(c.flaggedAtUtc).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <span style={statusBadgeStyle(
                  c.publicVerifyState === "PUBLISHED" ? "ACTIVE" : "RELEASED",
                )}>{c.publicVerifyState}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {releaseDialog ? (
        <ReleaseHoldDialog
          hold={releaseDialog}
          onCancel={() => setReleaseDialog(null)}
          onConfirm={(note) => releaseHold(releaseDialog, note)}
        />
      ) : null}
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        fontSize: 14,
        color: "#334155",
      }}
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function ReleaseHoldDialog({
  hold,
  onCancel,
  onConfirm,
}: {
  hold: LegalHold;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h3 style={sectionTitleStyle}>Release legal hold</h3>
        <p style={{ ...mutedStyle, marginBottom: 12 }}>
          Releasing the hold on <strong>{hold.title}</strong> removes the
          preservation block on the linked evidence. The release note is
          recorded in the internal audit trail. It is not shared with the
          contributor or public verify.
        </p>
        <textarea
          style={{ ...inputStyle, minHeight: 100 }}
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 4000))}
          placeholder="Reason for release"
          autoFocus
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={note.trim().length === 0}
            onClick={() => onConfirm(note.trim())}
          >
            Release
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
};
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const holdRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #e2e8f0",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  color: "#334155",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 20px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  maxWidth: 480,
  width: "100%",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
};

function statusBadgeStyle(status: "ACTIVE" | "RELEASED"): React.CSSProperties {
  return status === "ACTIVE"
    ? {
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        background: "#fef3c7",
        border: "1px solid #fde68a",
        color: "#92400e",
        borderRadius: 999,
      }
    : {
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        background: "#f1f5f9",
        border: "1px solid #cbd5e1",
        color: "#475569",
        borderRadius: 999,
      };
}
