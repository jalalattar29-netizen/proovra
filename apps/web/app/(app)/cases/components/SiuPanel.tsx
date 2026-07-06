"use client";

/**
 * Phase M3 — SIU panel for the case workspace.
 *
 * Bounded UI that lets the operator:
 *   * view + upsert the SIU profile
 *   * see the bounded evidence checklist + status per item
 *   * view review indicators (NEVER labelled as fraud)
 *   * request a follow-up
 *   * run an export preflight
 *   * download an SIU bundle (when preflight clears; warnings require
 *     an explicit operator reason)
 *
 * Hard rules:
 *   * Bounded copy on every label. NEVER claims fraud / authenticity /
 *     admissibility.
 *   * No PII rendering when the API returns redacted placeholders.
 *   * Loading / error / empty / blocked states are explicit.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";

const SIU_STANDING_CAPTION =
  "SIU bundles are operational signals. They do not determine fraud, authorship, or legal admissibility.";

type ClaimType =
  | "auto"
  | "property"
  | "injury"
  | "liability"
  | "travel"
  | "cyber"
  | "other";

type InvestigationStatus =
  | "intake"
  | "collecting"
  | "review"
  | "follow_up"
  | "export_ready"
  | "exported"
  | "closed";

type ChecklistItemStatus =
  | "missing"
  | "submitted"
  | "mapped"
  | "satisfied"
  | "waived";

type ChecklistItem = {
  itemId: string;
  label: string;
  required: boolean;
  status: ChecklistItemStatus;
  mappedEvidenceIds: ReadonlyArray<string>;
  note: string | null;
};

type ReviewIndicator = {
  code: string;
  explanation: string;
  evidenceId: string | null;
  observedAtUtc: string;
  severity: "info" | "warning" | "block_export";
};

type FollowUpRequest = {
  id: string;
  checklistItemId: string;
  status:
    | "open"
    | "sent"
    | "received"
    | "satisfied"
    | "expired"
    | "cancelled";
  dueByUtc: string | null;
  requestedAtUtc: string;
  note: string | null;
  intakeLinkId: string | null;
  receivedAtUtc: string | null;
  returnedEvidenceIds: ReadonlyArray<string>;
};

type Profile = {
  schemaVersion: string;
  caseId: string;
  teamId: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  claimType: ClaimType;
  investigationStatus: InvestigationStatus;
  claimNumber: string | null;
  policyReference: string | null;
  incidentDate: string | null;
  incidentLocation: string | null;
  lossDescription: string | null;
  assignedAdjusterUserId: string | null;
  assignedSIUReviewerUserId: string | null;
  claimantName: string | null;
  claimantContact: string | null;
  privacyGatedFieldsExposed: boolean;
  intakeTemplateId: string | null;
  checklist: ReadonlyArray<ChecklistItem>;
  reviewIndicators: ReadonlyArray<ReviewIndicator>;
  followUps: ReadonlyArray<FollowUpRequest>;
};

type ExportHistoryRow = {
  id: string;
  exportStatus: string;
  readinessState: string;
  warningCodes: ReadonlyArray<string>;
  blockerCodes: ReadonlyArray<string>;
  warningExportReason: string | null;
  artifactSha256: string | null;
  manifestSha256: string | null;
  artifactSizeBytes: string | null;
  artifactInclusion: {
    reportsIncluded: number;
    reportsMissing: number;
    verificationPackagesIncluded: number;
    verificationPackagesMissing: number;
  } | null;
  generatedByUserId: string | null;
  generatedAtUtc: string;
  downloadedAtUtc: string | null;
};

type PreflightFinding = {
  code: string;
  severity: "warning" | "blocker";
  detail: string;
  evidenceId: string | null;
};

type Preflight = {
  caseId: string;
  evaluatedAtUtc: string;
  readiness: "ready" | "ready_with_warnings" | "blocked" | "unavailable";
  findings: ReadonlyArray<PreflightFinding>;
  totals: {
    warnings: number;
    blockers: number;
    requiredChecklistItems: number;
    satisfiedChecklistItems: number;
    openFollowUps: number;
  };
  limitations: ReadonlyArray<string>;
};

export type SiuPanelProps = {
  caseId: string;
};

export function SiuPanel({ caseId }: SiuPanelProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<ExportHistoryRow> | null>(null);
  const [piiRevealed, setPiiRevealed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportReason, setExportReason] = useState("");

  const loadProfile = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/cases/${caseId}/siu-profile`)) as
        | {
            profile: Profile;
            durable?: boolean;
            storage?: string;
            piiRedacted?: boolean;
          }
        | { error: { code: string } };
      if ("profile" in res) {
        setProfile(res.profile);
        setPiiRevealed(res.profile.privacyGatedFieldsExposed);
      } else {
        // Phase CASE-DETAIL-PERSONAL-UX — backend returned the
        // `{error:{code:...}}` envelope (e.g. `siu_profile_not_found`).
        // Treat it as the empty-state, NEVER render the raw JSON.
        setProfile(null);
      }
    } catch (e) {
      // Phase CASE-DETAIL-PERSONAL-UX — `apiFetch` rejects with a
      // message whose body is sometimes the raw JSON error payload
      // (`{"error":{"code":"siu_profile_not_found",...}}`). The
      // previous handler dropped `e.message` straight into the UI,
      // exposing that JSON. We now treat any 404 + the canonical
      // `siu_profile_not_found` code as the empty-state, and use a
      // bounded "couldn't load" sentence for every other error
      // shape. Raw payloads never reach the DOM.
      if (e instanceof Error) {
        // Internal error-kind detection only — raw message is regex-tested
        // to spot the empty-state code, never rendered.
        const msg = e.message;
        if (/404/.test(msg) || /siu_profile_not_found/.test(msg)) {
          setProfile(null);
          return;
        }
      }
      setErr("Couldn't load the investigation profile right now.");
    }
  }, [caseId]);

  const loadHistory = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/cases/${caseId}/siu-exports`)) as {
        exports: ReadonlyArray<ExportHistoryRow>;
      };
      setHistory(res.exports);
    } catch {
      setHistory([]);
    }
  }, [caseId]);

  const revealPii = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/cases/${caseId}/siu-profile/reveal-pii`,
        { method: "POST" },
      )) as { profile: Profile; piiRedacted: false };
      setProfile(res.profile);
      setPiiRevealed(true);
    } catch {
      // Phase CASE-DETAIL-PERSONAL-UX — bounded user-safe error copy
      // regardless of backend response shape. Raw JSON payloads
      // never reach the DOM.
      setErr("PII reveal failed. This action needs an additional security step.");
    }
  }, [caseId]);

  useEffect(() => {
    void loadProfile();
    void loadHistory();
  }, [loadProfile, loadHistory]);

  const runPreflight = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = (await apiFetch(
        `/v1/cases/${caseId}/siu-export/preflight`,
      )) as { preflight: Preflight };
      setPreflight(res.preflight);
    } catch {
      // Phase CASE-DETAIL-PERSONAL-UX — bounded user-safe error copy.
      setErr("Couldn't run the export preflight check right now.");
    } finally {
      setBusy(false);
    }
  }, [caseId]);

  const generateExport = useCallback(async () => {
    if (!preflight) return;
    if (preflight.readiness === "blocked") return;
    if (
      preflight.readiness === "ready_with_warnings" &&
      exportReason.trim().length < 8
    ) {
      setErr(
        "Export with warnings requires a bounded reason (at least 8 chars).",
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // POST returns binary ZIP; we trigger a browser download.
      const res = await fetch(`/v1/cases/${caseId}/siu-export`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warningExportReason:
            preflight.readiness === "ready_with_warnings"
              ? exportReason.trim()
              : null,
        }),
      });
      if (!res.ok) {
        // Phase CASE-DETAIL-PERSONAL-UX — never render the raw body
        // (it may be a JSON error payload, an HTML 500 page, etc.).
        // Surface only the bounded HTTP status + a human sentence.
        await res.text().catch(() => "");
        setErr(
          res.status === 403
            ? "Export refused — you don't have permission to export this case."
            : res.status === 409
              ? "Export refused — the case isn't ready to export yet. Run preflight and resolve any blockers."
              : `Export refused (HTTP ${res.status}).`,
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `siu-export-${caseId}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Phase CASE-DETAIL-PERSONAL-UX — bounded user-safe error copy.
      setErr("Couldn't export the case right now. Try again or contact support.");
    } finally {
      setBusy(false);
    }
  }, [caseId, exportReason, preflight]);

  const summary = useMemo(() => {
    if (!profile) return null;
    const required = profile.checklist.filter((c) => c.required);
    const satisfied = required.filter(
      (c) => c.status === "satisfied" || c.status === "mapped",
    );
    return {
      requiredCount: required.length,
      satisfiedCount: satisfied.length,
      indicatorCount: profile.reviewIndicators.length,
      openFollowUps: profile.followUps.filter(
        (f) =>
          f.status === "open" ||
          f.status === "sent" ||
          f.status === "received",
      ).length,
    };
  }, [profile]);

  return (
    <section data-testid="siu-panel" style={panelStyle}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Insurance / SIU</h2>
        <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 13 }}>
          {SIU_STANDING_CAPTION}
        </p>
      </header>

      {err ? (
        <div style={errBox} data-testid="siu-error">
          {err}
        </div>
      ) : null}

      {!profile ? (
        <p style={mutedText} data-testid="siu-empty">
          {/* Phase CASE-DETAIL-PERSONAL-UX — spec-locked empty-state
              copy. The prior text leaked the literal backend route
              path (`PUT /v1/cases/.../siu-profile`) into user copy. */}
          No investigation profile has been created for this case.
        </p>
      ) : (
        <>
          <table style={tableStyle} data-testid="siu-profile-summary">
            <tbody>
              <tr>
                <td style={th}>Claim type</td>
                <td style={td}>
                  <code>{profile.claimType}</code>
                </td>
              </tr>
              <tr>
                <td style={th}>Investigation status</td>
                <td style={td}>
                  <code>{profile.investigationStatus}</code>
                </td>
              </tr>
              <tr>
                <td style={th}>Claim number</td>
                <td style={td}>{profile.claimNumber ?? "—"}</td>
              </tr>
              <tr>
                <td style={th}>Incident date</td>
                <td style={td}>{profile.incidentDate ?? "—"}</td>
              </tr>
              <tr>
                <td style={th}>Incident location</td>
                <td style={td}>{profile.incidentLocation ?? "—"}</td>
              </tr>
              <tr>
                <td style={th}>Claimant name</td>
                <td style={td} data-testid="siu-claimant-name">
                  {profile.claimantName ?? "—"}
                  {!piiRevealed && profile.claimantName ? (
                    <button
                      type="button"
                      onClick={() => void revealPii()}
                      style={{ marginLeft: 8, ...ghostBtn }}
                      data-testid="siu-reveal-pii-button"
                    >
                      Reveal PII
                    </button>
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={mutedText} data-testid="siu-durability-note">
            Durable storage: Prisma. PII redacted by default; reveal requires
            capability + step-up.
          </p>

          {summary ? (
            <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
              <Stat label="Required" value={`${summary.satisfiedCount}/${summary.requiredCount}`} />
              <Stat label="Indicators" value={String(summary.indicatorCount)} />
              <Stat label="Open follow-ups" value={String(summary.openFollowUps)} />
            </div>
          ) : null}

          {/* Checklist */}
          <h3 style={h3}>Evidence checklist</h3>
          <table style={tableStyle} data-testid="siu-checklist">
            <thead>
              <tr>
                <th style={th}>Item</th>
                <th style={th}>Required</th>
                <th style={th}>Status</th>
                <th style={th}>Mapped evidence</th>
              </tr>
            </thead>
            <tbody>
              {profile.checklist.map((item) => (
                <tr key={item.itemId}>
                  <td style={td}>{item.label}</td>
                  <td style={td}>{item.required ? "yes" : "no"}</td>
                  <td style={td}>
                    <code>{item.status}</code>
                  </td>
                  <td style={td}>{item.mappedEvidenceIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Indicators */}
          {profile.reviewIndicators.length > 0 ? (
            <>
              <h3 style={h3}>Review indicators</h3>
              <p style={mutedText}>
                Operational signals that an SIU reviewer can act on. These
                are <strong>not</strong> fraud findings.
              </p>
              <ul data-testid="siu-indicators">
                {profile.reviewIndicators.map((ind, i) => (
                  <li key={`${ind.code}-${i}`}>
                    <code>{ind.code}</code> — {ind.explanation}{" "}
                    <span style={{ color: "#64748b" }}>({ind.severity})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {/* Export */}
          <h3 style={h3}>SIU export</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void runPreflight()}
              disabled={busy}
              style={ghostBtn}
              data-testid="siu-preflight-button"
            >
              Run preflight
            </button>
            <button
              type="button"
              onClick={() => void generateExport()}
              disabled={
                busy ||
                !preflight ||
                preflight.readiness === "blocked" ||
                preflight.readiness === "unavailable"
              }
              style={primaryBtn}
              data-testid="siu-export-button"
            >
              Generate SIU bundle
            </button>
          </div>
          {preflight ? (
            <div style={{ marginTop: 8 }} data-testid="siu-preflight-result">
              <p>
                Readiness: <code>{preflight.readiness}</code> · warnings:{" "}
                <strong>{preflight.totals.warnings}</strong> · blockers:{" "}
                <strong>{preflight.totals.blockers}</strong>
              </p>
              {preflight.readiness === "ready_with_warnings" ? (
                <input
                  type="text"
                  placeholder="Bounded reason for exporting with warnings (≥8 chars)"
                  value={exportReason}
                  onChange={(e) => setExportReason(e.target.value)}
                  data-testid="siu-export-reason"
                  style={{ width: "100%", padding: 6, marginTop: 4 }}
                />
              ) : null}
              {preflight.findings.length > 0 ? (
                <ul style={{ marginTop: 6 }}>
                  {preflight.findings.map((f, i) => (
                    <li key={`${f.code}-${i}`}>
                      <code>{f.code}</code> — {f.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* Export history (Phase M3.1 + M3.2 download) */}
          {history && history.length > 0 ? (
            <>
              <h3 style={h3}>Export history</h3>
              <table style={tableStyle} data-testid="siu-export-history">
                <thead>
                  <tr>
                    <th style={th}>Generated (UTC)</th>
                    <th style={th}>Status</th>
                    <th style={th}>Readiness</th>
                    <th style={th}>Reports</th>
                    <th style={th}>Verification Packages</th>
                    <th style={th}>Artifact SHA-256</th>
                    <th style={th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const downloadable =
                      h.exportStatus === "generated" ||
                      h.exportStatus === "downloaded";
                    return (
                      <tr key={h.id}>
                        <td style={td}>
                          <code>{h.generatedAtUtc}</code>
                        </td>
                        <td style={td}>
                          <code>{h.exportStatus}</code>
                        </td>
                        <td style={td}>
                          <code>{h.readinessState}</code>
                        </td>
                        <td style={td}>
                          {h.artifactInclusion
                            ? `${h.artifactInclusion.reportsIncluded} included / ${h.artifactInclusion.reportsMissing} missing`
                            : "—"}
                        </td>
                        <td style={td}>
                          {h.artifactInclusion
                            ? `${h.artifactInclusion.verificationPackagesIncluded} included / ${h.artifactInclusion.verificationPackagesMissing} missing`
                            : "—"}
                        </td>
                        <td style={td}>
                          <code>
                            {h.artifactSha256
                              ? `${h.artifactSha256.slice(0, 16)}…`
                              : "—"}
                          </code>
                        </td>
                        <td style={td}>
                          {downloadable ? (
                            <a
                              href={`/v1/cases/${caseId}/siu-exports/${h.id}/download`}
                              download
                              data-testid="siu-export-download-link"
                              style={{ color: "#0f172a", textDecoration: "underline" }}
                            >
                              Download
                            </a>
                          ) : (
                            <span style={{ color: "#94a3b8" }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p style={mutedText} data-testid="siu-history-storage-note">
                Storage keys are never rendered. Bundle integrity is asserted
                by the SHA-256 columns and the durable export row.
              </p>
            </>
          ) : null}

          {/* Standing limitations */}
          <h3 style={h3}>Standing limitations</h3>
          <ul style={{ fontSize: 12 }}>
            <li>
              <code>SIU_BUNDLE_IS_NOT_A_FRAUD_DETERMINATION</code>
            </li>
            <li>
              <code>SIU_BUNDLE_DOES_NOT_PROVE_CONTENT_TRUTH</code>
            </li>
            <li>
              <code>SIU_BUNDLE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY</code>
            </li>
            <li>
              <code>REVIEW_INDICATORS_ARE_OPERATIONAL_SIGNALS_NOT_FINDINGS</code>
            </li>
            <li>
              <code>PROOVRA_DOES_NOT_REPLACE_INSURER_CORE_SYSTEMS</code>
            </li>
          </ul>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={mutedText}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 16,
  border: "1px solid #e2e8f0",
  background: "#ffffff",
  borderRadius: 8,
  fontSize: 13,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
  marginTop: 4,
};
const th: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #f1f5f9",
  textAlign: "left",
  color: "#475569",
  fontWeight: 600,
  verticalAlign: "top",
};
const td: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const h3: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginTop: 16,
  marginBottom: 6,
};
const mutedText: React.CSSProperties = { color: "#475569", fontSize: 12 };
const errBox: React.CSSProperties = {
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 8,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  background: "#0f172a",
  color: "#fff",
  border: "1px solid #0f172a",
  borderRadius: 6,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#fff",
  color: "#0f172a",
  borderColor: "#cbd5e1",
};
