"use client";

/**
 * Phase Final-Hidden-Feature-Surfacing — UI panels for the 9 documented
 * backend capabilities that previously had no operator-facing surface.
 *
 * Every panel below:
 *   - Calls a real backend endpoint (no mock data, no placeholders).
 *   - Shows loading / empty / error / forbidden states explicitly.
 *   - Is mounted exactly once on its canonical host page.
 *
 * Surfaced features:
 *
 *   1. `CaseRiskPanel`                — `GET /v1/cases/:id/risk`
 *      Host: `MatterWorkspace.tsx`
 *
 *   2. `EvidenceAiCategorizationCard` — `GET /v1/evidence/:id/ai-categorization`
 *      Host: `/evidence/[id]/page.tsx`
 *
 *   3. `ImmutableStorageDriftSection` — `GET /v1/governance/immutable-storage-checks`
 *      Host: `/governance/lifecycle/page.tsx`
 *
 *   4. `MfaRecoveryApprovalHistoryBlock` — `GET /v1/identity/mfa-admin/recovery-requests/:requestId/approvals`
 *      Host: `/security-center/mfa-recovery/page.tsx`
 *
 *   5. `EvidenceRequestEventsTab`     — `GET /v1/evidence-requests/:id/events`
 *      Host: `/evidence-requests/[id]/page.tsx`
 *
 *   6. `WorkspacePersonaProfileCard`  — `GET /v1/workspaces/:teamId/persona`
 *      Host: `/settings/persona/page.tsx`
 *
 *   7. `OrgHealthSnapshotCard`        — `GET /v1/dashboard/org-health?teamId=`
 *      Host: `/security-center/page.tsx`
 *
 *   8. `ReviewerRoutingRecommendationsPane` — `GET /v1/reviewer/routing-recommendations`
 *      Host: `ReviewerConsole.tsx`
 *
 *   9. `AccessAnomaliesCard`          — `GET /v1/security-center/access-anomalies`
 *      Host: `/security-center/page.tsx`
 *
 * SIU review indicators are surfaced directly from the already-fetched
 * SIU profile in `apps/web/app/(app)/cases/components/SiuPanel.tsx`
 * (mounted by `MatterWorkspace.tsx`) — no separate panel needed here.
 *
 * The panels are intentionally kept lean and self-contained — they
 * style themselves so the host pages don't need wiring beyond
 * importing + mounting. Each panel carries a stable `data-cc-panel`
 * attribute so the Phase Final contract test can pin the mount.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";

// -----------------------------------------------------------------------------
// Shared styles (used by every panel for consistency without a redesign)
// -----------------------------------------------------------------------------

const card: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  padding: 16,
  marginBottom: 12,
};

const heading: React.CSSProperties = {
  margin: 0,
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#dce1de",
};

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "rgba(220,225,222,0.7)",
};

const errBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.18)",
  border: "1px solid rgba(179,38,30,0.45)",
  color: "#f7d4d1",
  fontSize: 12,
};

const pill = (tone: "neutral" | "warn" | "danger" | "ok"): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  border:
    tone === "danger"
      ? "1px solid rgba(179,38,30,0.55)"
      : tone === "warn"
        ? "1px solid rgba(241,162,58,0.55)"
        : tone === "ok"
          ? "1px solid rgba(125,200,175,0.55)"
          : "1px solid rgba(255,255,255,0.18)",
  background:
    tone === "danger"
      ? "rgba(179,38,30,0.16)"
      : tone === "warn"
        ? "rgba(241,162,58,0.16)"
        : tone === "ok"
          ? "rgba(125,200,175,0.16)"
          : "rgba(255,255,255,0.06)",
  color:
    tone === "danger"
      ? "#f7d4d1"
      : tone === "warn"
        ? "#f0d2a0"
        : tone === "ok"
          ? "#cde5dc"
          : "rgba(220,225,222,0.85)",
});

const scoreNumber: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 800,
  letterSpacing: -1,
  color: "#dce1de",
  lineHeight: 1.1,
};

function tsFmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  return formatUserDateTime(ts);
}

function severityTone(
  severity: string | null | undefined,
): "neutral" | "warn" | "danger" {
  const up = (severity ?? "").toUpperCase();
  if (up === "HIGH" || up === "CRITICAL") return "danger";
  if (up === "MEDIUM" || up === "WARNING" || up === "WARN") return "warn";
  return "neutral";
}

function riskLevelTone(
  level: string | null | undefined,
): "ok" | "neutral" | "warn" | "danger" {
  const up = (level ?? "").toUpperCase();
  if (up === "CRITICAL" || up === "HIGH") return "danger";
  if (up === "MEDIUM") return "warn";
  if (up === "LOW") return "ok";
  return "neutral";
}

// =============================================================================
// 1. CaseRiskPanel
// =============================================================================

interface CaseRiskSnapshot {
  riskScore: number | null;
  riskLevel: string | null;
  evidenceGapCount: number;
  openIncidentCount: number;
  activeWorkflowCount: number;
  overdueWorkflowCount: number;
  governanceBlockerCount: number;
  reviewerPressureScore: number | null;
  auditReadinessScore: number | null;
  custodyConcernCount: number;
  integrityConcernCount: number;
  packageReportGapCount: number;
  reasonCodes: ReadonlyArray<string>;
  recommendedAction: string | null;
  sampledAtUtc: string;
}

export function CaseRiskPanel({ caseId }: { caseId: string }) {
  const [snap, setSnap] = useState<CaseRiskSnapshot | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/risk`)
      .then(
        (
          res: { snapshot: CaseRiskSnapshot | null; hint?: string },
        ) => {
          if (cancelled) return;
          setSnap(res.snapshot);
          setHint(res.hint ?? null);
        },
      )
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have permission to view risk for this matter.");
        } else if (e?.status === 404) {
          setErr("Matter not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load risk snapshot." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  return (
    <section data-cc-panel="case-risk" style={card}>
      <h2 style={heading}>Matter risk snapshot</h2>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !snap ? (
        <p style={muted}>{hint ?? "Loading…"}</p>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div>
              <div style={scoreNumber}>{snap.riskScore ?? "—"}</div>
              <div style={muted}>Sampled {tsFmt(snap.sampledAtUtc)}</div>
            </div>
            {snap.riskLevel ? (
              <span style={pill(riskLevelTone(snap.riskLevel))}>
                {snap.riskLevel}
              </span>
            ) : null}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              fontSize: 12,
              color: "#dce1de",
            }}
          >
            <div>
              Evidence gaps: <strong>{snap.evidenceGapCount}</strong>
            </div>
            <div>
              Open incidents: <strong>{snap.openIncidentCount}</strong>
            </div>
            <div>
              Active workflows: <strong>{snap.activeWorkflowCount}</strong>
            </div>
            <div>
              Overdue workflows: <strong>{snap.overdueWorkflowCount}</strong>
            </div>
            <div>
              Governance blockers: <strong>{snap.governanceBlockerCount}</strong>
            </div>
            <div>
              Custody concerns: <strong>{snap.custodyConcernCount}</strong>
            </div>
            <div>
              Integrity concerns: <strong>{snap.integrityConcernCount}</strong>
            </div>
            <div>
              Package gaps: <strong>{snap.packageReportGapCount}</strong>
            </div>
          </div>

          {snap.reasonCodes.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div style={muted}>Top reasons</div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {snap.reasonCodes.slice(0, 6).map((r) => (
                  <span key={r} style={pill("neutral")}>
                    {r}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {snap.recommendedAction ? (
            <div style={{ ...muted, marginTop: 10, fontStyle: "italic" }}>
              Recommended: {snap.recommendedAction}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// =============================================================================
// 2. EvidenceAiCategorizationCard
// =============================================================================

interface AiCategorization {
  status: string;
  summary: string | null;
  categories: ReadonlyArray<{ label?: string; confidence?: number }>;
  suggestedTags: ReadonlyArray<string>;
  riskFlags: ReadonlyArray<string>;
}

export function EvidenceAiCategorizationCard({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const [cat, setCat] = useState<AiCategorization | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/ai-categorization`)
      .then((res: { categorization: AiCategorization }) => {
        if (cancelled) return;
        setCat(res.categorization);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have access to view AI categorization for this evidence.");
        } else if (e?.status === 404) {
          setErr("Evidence not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load categorization." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  return (
    <section data-cc-panel="evidence-ai-categorization" style={card}>
      <h2 style={heading}>AI categorization (advisory)</h2>
      <p style={muted}>
        AI-suggested category and tags. <strong>Advisory only</strong> — a
        reviewer must verify before relying on any classification.
      </p>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !cat ? (
        <p style={muted}>Loading…</p>
      ) : cat.status === "DISABLED" ? (
        <p style={muted}>
          AI categorization is not configured for this workspace.
        </p>
      ) : cat.status === "PENDING" ? (
        <p style={muted}>Categorization is in progress…</p>
      ) : (
        <>
          {cat.summary ? (
            <p style={{ ...muted, color: "#dce1de" }}>{cat.summary}</p>
          ) : null}
          {cat.categories.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={muted}>Suggested categories</div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {cat.categories.slice(0, 6).map((c, idx) => (
                  <span key={`${c.label ?? idx}`} style={pill("neutral")}>
                    {c.label ?? "category"}
                    {typeof c.confidence === "number"
                      ? ` · ${(c.confidence * 100).toFixed(0)}%`
                      : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {cat.suggestedTags.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div style={muted}>Suggested tags</div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {cat.suggestedTags.slice(0, 8).map((t) => (
                  <span key={t} style={pill("neutral")}>
                    #{t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {cat.riskFlags.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div style={muted}>Risk flags</div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 6,
                }}
              >
                {cat.riskFlags.map((r) => (
                  <span key={r} style={pill("warn")}>
                    {r}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// =============================================================================
// 3. ImmutableStorageDriftSection
// =============================================================================

interface ImmutableStorageCheckRow {
  id: string;
  evidenceId: string;
  outcome: string;
  checkedAtUtc: string;
  dbRetentionUntilUtc: string | null;
  dbLegalHoldActive: boolean;
  dbImmutable: boolean;
  storageRetainUntilUtc: string | null;
  storageLegalHoldActive: boolean;
  storageComplianceMode: string | null;
  raisedIncidentId: string | null;
  driftSummary: string | null;
}

export function ImmutableStorageDriftSection({
  teamId,
}: {
  teamId: string;
}) {
  const [rows, setRows] = useState<ImmutableStorageCheckRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    const qs = new URLSearchParams({
      teamId,
      driftOnly: showAll ? "false" : "true",
      limit: "50",
    }).toString();
    apiFetch(`/v1/governance/immutable-storage-checks?${qs}`)
      .then((res: { checks: ImmutableStorageCheckRow[] }) => {
        if (cancelled) return;
        setRows(res.checks ?? []);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have permission to view storage drift.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load storage drift." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, showAll]);

  const driftCount = useMemo(
    () => (rows ?? []).filter((r) => r.outcome !== "OK").length,
    [rows],
  );

  return (
    <section data-cc-panel="immutable-storage-drift" style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <h2 style={heading}>Immutable storage drift</h2>
        <label
          style={{
            ...muted,
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 0,
          }}
        >
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show all checks
        </label>
      </div>
      <p style={muted}>
        Reconciler-detected mismatches between the DB lifecycle state and
        the storage-bucket retention/legal-hold pin.
      </p>

      {err ? (
        <div style={errBox}>{err}</div>
      ) : !rows ? (
        <p style={muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>
          {showAll
            ? "No checks recorded in the recent window."
            : "No drift detected — DB and storage retention agree across all checked evidence."}
        </p>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div style={muted}>
            {driftCount} drift row(s) out of {rows.length} checked.
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {rows.slice(0, 20).map((r) => (
              <li
                key={r.id}
                data-cc-drift-row={r.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 6,
                  background:
                    r.outcome === "OK"
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(179,38,30,0.10)",
                  border:
                    r.outcome === "OK"
                      ? "1px solid rgba(255,255,255,0.08)"
                      : "1px solid rgba(179,38,30,0.40)",
                  fontSize: 12,
                  color: "#dce1de",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>
                    <span style={pill(r.outcome === "OK" ? "ok" : "danger")}>
                      {r.outcome}
                    </span>{" "}
                    <span style={muted}>
                      evidence {r.evidenceId.slice(0, 8)}…
                    </span>
                  </span>
                  <span style={muted}>{tsFmt(r.checkedAtUtc)}</span>
                </div>
                {r.driftSummary ? (
                  <div style={{ ...muted, marginTop: 4 }}>{r.driftSummary}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// 4. MfaRecoveryApprovalHistoryBlock
// =============================================================================

interface MfaRecoveryApproval {
  id: string;
  approverUserId: string;
  approverDisplayName: string | null;
  createdAt: string;
}

export function MfaRecoveryApprovalHistoryBlock({
  requestId,
}: {
  requestId: string;
}) {
  const [rows, setRows] = useState<MfaRecoveryApproval[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(
      `/v1/identity/mfa-admin/recovery-requests/${encodeURIComponent(
        requestId,
      )}/approvals`,
    )
      .then((res: { approvals: MfaRecoveryApproval[] }) => {
        if (cancelled) return;
        setRows(res.approvals ?? []);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You are not authorized to view approvals for this request.");
        } else if (e?.status === 404) {
          setErr("Request not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load approvals." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  return (
    <section data-cc-panel="mfa-recovery-approval-history" style={card}>
      <h2 style={heading}>Approval history</h2>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !rows ? (
        <p style={muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>No approvals recorded yet.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, color: "#dce1de", fontSize: 12 }}>
          {rows.map((r) => (
            <li
              key={r.id}
              data-cc-approval-row={r.id}
              style={{ marginBottom: 6 }}
            >
              <strong>
                {r.approverDisplayName ?? r.approverUserId.slice(0, 12) + "…"}
              </strong>{" "}
              <span style={muted}>{tsFmt(r.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// =============================================================================
// 5. EvidenceRequestEventsTab
// =============================================================================

interface EvidenceRequestEventRow {
  id: string;
  eventType: string;
  actorUserId?: string | null;
  occurredAtUtc?: string;
  createdAt?: string;
  status?: string | null;
  detail?: string | null;
  reason?: string | null;
}

export function EvidenceRequestEventsTab({
  requestId,
}: {
  requestId: string;
}) {
  const [rows, setRows] = useState<EvidenceRequestEventRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(
      `/v1/evidence-requests/${encodeURIComponent(requestId)}/events`,
    )
      .then((res: { events: EvidenceRequestEventRow[] }) => {
        if (cancelled) return;
        setRows(res.events ?? []);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have access to this request's events.");
        } else if (e?.status === 404) {
          setErr("Request not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load events." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  return (
    <section data-cc-panel="evidence-request-events" style={card}>
      <h2 style={heading}>Activity timeline</h2>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !rows ? (
        <p style={muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>No events recorded for this request.</p>
      ) : (
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {rows.map((e) => (
            <li
              key={e.id}
              data-cc-evidence-request-event-row={e.id}
              style={{
                padding: "8px 10px",
                marginBottom: 4,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontSize: 12,
                color: "#dce1de",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <strong>{e.eventType}</strong>
                <span style={muted}>
                  {tsFmt(e.occurredAtUtc ?? e.createdAt)}
                </span>
              </div>
              {e.status ? (
                <div style={{ marginTop: 2 }}>
                  <span style={pill("neutral")}>{e.status}</span>
                </div>
              ) : null}
              {e.detail || e.reason ? (
                <div style={{ ...muted, marginTop: 4 }}>
                  {e.detail ?? e.reason}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// =============================================================================
// 6. WorkspacePersonaProfileCard
// =============================================================================

interface WorkspacePersonaProfile {
  primaryProfile: string | null;
  secondaryProfile?: string | null;
  customizations?: Record<string, unknown> | null;
  updatedAt?: string | null;
}

export function WorkspacePersonaProfileCard({ teamId }: { teamId: string }) {
  const [profile, setProfile] = useState<WorkspacePersonaProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(`/v1/workspaces/${encodeURIComponent(teamId)}/persona`)
      .then((res: { profile?: WorkspacePersonaProfile | null } | WorkspacePersonaProfile) => {
        if (cancelled) return;
        const p =
          (res as { profile?: WorkspacePersonaProfile | null })?.profile ??
          (res as WorkspacePersonaProfile);
        setProfile(p ?? null);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You are not authorized to read the workspace persona.");
        } else if (e?.status === 404) {
          setErr("Workspace not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load persona." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return (
    <section data-cc-panel="workspace-persona-profile" style={card}>
      <h2 style={heading}>Workspace persona</h2>
      <p style={muted}>
        The durable workspace persona profile drives default hubs, sidebar
        priority, and operator priorities.
      </p>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !profile ? (
        <p style={muted}>Loading…</p>
      ) : !profile.primaryProfile ? (
        <p style={muted}>No persona configured for this workspace yet.</p>
      ) : (
        <div style={{ marginTop: 6, color: "#dce1de", fontSize: 12 }}>
          <div>
            Primary: <strong>{profile.primaryProfile}</strong>
          </div>
          {profile.secondaryProfile ? (
            <div>
              Secondary: <strong>{profile.secondaryProfile}</strong>
            </div>
          ) : null}
          {profile.updatedAt ? (
            <div style={muted}>Updated {tsFmt(profile.updatedAt)}</div>
          ) : null}
        </div>
      )}
    </section>
  );
}

// =============================================================================
// 7. OrgHealthSnapshotCard
// =============================================================================

interface OrgHealthSnapshot {
  healthScore: number | null;
  operationalMaturityScore: number | null;
  governanceMaturityScore: number | null;
  auditReadinessScore: number | null;
  reviewerMaturityScore: number | null;
  incidentFrequency7d: number | null;
  workflowCompletion7d: number | null;
  queueReliabilityScore: number | null;
  artifactReliabilityScore: number | null;
  sampledAtUtc: string | null;
}

export function OrgHealthSnapshotCard({ teamId }: { teamId: string }) {
  const [snap, setSnap] = useState<OrgHealthSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    apiFetch(
      `/v1/dashboard/org-health?teamId=${encodeURIComponent(teamId)}`,
    )
      .then((res: { snapshot: OrgHealthSnapshot }) => {
        if (cancelled) return;
        setSnap(res.snapshot ?? null);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have permission to view org health.");
        } else if (e?.status === 404) {
          setErr("Workspace not found.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load health snapshot." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return (
    <section data-cc-panel="org-health-snapshot" style={card}>
      <h2 style={heading}>Organizational health</h2>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !snap ? (
        <p style={muted}>Loading…</p>
      ) : snap.healthScore == null && snap.sampledAtUtc == null ? (
        <p style={muted}>No health snapshot recorded yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
            <div style={scoreNumber}>{snap.healthScore ?? "—"}</div>
            <div style={muted}>Sampled {tsFmt(snap.sampledAtUtc)}</div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              marginTop: 10,
              fontSize: 12,
              color: "#dce1de",
            }}
          >
            <div>Operational maturity: <strong>{snap.operationalMaturityScore ?? "—"}</strong></div>
            <div>Governance maturity: <strong>{snap.governanceMaturityScore ?? "—"}</strong></div>
            <div>Audit readiness: <strong>{snap.auditReadinessScore ?? "—"}</strong></div>
            <div>Reviewer maturity: <strong>{snap.reviewerMaturityScore ?? "—"}</strong></div>
            <div>Incidents (7d): <strong>{snap.incidentFrequency7d ?? "—"}</strong></div>
            <div>Workflows done (7d): <strong>{snap.workflowCompletion7d ?? "—"}</strong></div>
            <div>Queue reliability: <strong>{snap.queueReliabilityScore ?? "—"}</strong></div>
            <div>Artifact reliability: <strong>{snap.artifactReliabilityScore ?? "—"}</strong></div>
          </div>
        </>
      )}
    </section>
  );
}

// =============================================================================
// 8. ReviewerRoutingRecommendationsPane
// =============================================================================

interface RoutingRecommendation {
  id: string;
  sourceReviewerUserId: string | null;
  targetReviewerUserId: string | null;
  recommendationType: string;
  severity: string;
  reasonCode: string;
  explanation: string;
  status: string;
  createdAt: string;
}

export function ReviewerRoutingRecommendationsPane({
  teamId,
}: {
  teamId: string;
}) {
  const [rows, setRows] = useState<RoutingRecommendation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    apiFetch(
      `/v1/reviewer/routing-recommendations?teamId=${encodeURIComponent(
        teamId,
      )}`,
    )
      .then((res: { recommendations: RoutingRecommendation[] }) => {
        setRows(res.recommendations ?? []);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (e?.status === 403) {
          setErr("You do not have permission to view routing recommendations.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load recommendations." }).message);
        }
      });
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    load();
  }, [teamId, load]);

  return (
    <section data-cc-panel="reviewer-routing-recommendations" style={card}>
      <h2 style={heading}>Routing recommendations</h2>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !rows ? (
        <p style={muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>No active routing recommendations.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.slice(0, 8).map((r) => (
            <li
              key={r.id}
              data-cc-routing-rec-row={r.id}
              style={{
                padding: "8px 10px",
                marginBottom: 6,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontSize: 12,
                color: "#dce1de",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>
                  <span style={pill(severityTone(r.severity))}>
                    {r.severity}
                  </span>{" "}
                  <strong>{r.recommendationType}</strong>
                </span>
                <span style={muted}>{tsFmt(r.createdAt)}</span>
              </div>
              <div style={{ ...muted, marginTop: 4 }}>{r.explanation}</div>
              <div style={{ ...muted, marginTop: 2 }}>
                Reason: <code>{r.reasonCode}</code>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// =============================================================================
// 9. AccessAnomaliesCard
// =============================================================================

interface AccessAnomalyRow {
  id: string;
  category: string;
  severity: string;
  status: string;
  sampleEventType: string;
  count: number;
  actorUserId: string | null;
  windowStartUtc: string;
  windowEndUtc: string;
  summary: string | null;
}

export function AccessAnomaliesCard({ teamId }: { teamId: string }) {
  const [rows, setRows] = useState<AccessAnomalyRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setErr(null);
    apiFetch(
      `/v1/security-center/access-anomalies?teamId=${encodeURIComponent(
        teamId,
      )}&limit=12`,
    )
      .then((res: { anomalies: AccessAnomalyRow[] }) => {
        if (cancelled) return;
        setRows(res.anomalies ?? []);
      })
      .catch((e: { message?: string; status?: number }) => {
        if (cancelled) return;
        if (e?.status === 403) {
          setErr("You do not have permission to view access anomalies.");
        } else {
          setErr(toSafeUserError(e, { message: "Could not load anomalies." }).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return (
    <section data-cc-panel="access-anomalies" style={card}>
      <h2 style={heading}>Access anomalies</h2>
      <p style={muted}>
        Bounded list of OPEN / ACKNOWLEDGED workspace access anomalies
        — login pattern shifts, unusual session origins, suspicious
        permission attempts.
      </p>
      {err ? (
        <div style={errBox}>{err}</div>
      ) : !rows ? (
        <p style={muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>No active anomalies.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((a) => (
            <li
              key={a.id}
              data-cc-access-anomaly-row={a.id}
              style={{
                padding: "8px 10px",
                marginBottom: 6,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontSize: 12,
                color: "#dce1de",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>
                  <span style={pill(severityTone(a.severity))}>
                    {a.severity}
                  </span>{" "}
                  <strong>{a.category}</strong>{" "}
                  <span style={muted}>· {a.status}</span>
                </span>
                <span style={muted}>{tsFmt(a.windowEndUtc)}</span>
              </div>
              <div style={{ ...muted, marginTop: 4 }}>
                {a.summary ??
                  `${a.sampleEventType} · ${a.count} event${
                    a.count === 1 ? "" : "s"
                  }`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
