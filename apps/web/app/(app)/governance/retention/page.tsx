"use client";

/**
 * Phase 27 — Retention Policies console.
 *
 * Operator surface for creating, updating, and transitioning versioned
 * retention policies (Phase 27 `EvidenceRetentionPolicy`). Replaces the
 * legacy default-retention-days field from Phase 14 with first-class
 * scoped policies (workspace / evidence-type / case / regulatory).
 *
 * Hard rules:
 *   - Free-form change notes are required on every mutation (audit
 *     trail), but the page NEVER displays privileged legal text from
 *     legal-hold rows. Notes shown here are operator-readable only.
 *   - SUPERSEDED / ARCHIVED policies cannot be re-edited (the API
 *     refuses with RETENTION_POLICY_TERMINAL).
 *   - Conflict warnings come from the dashboard route, not derived
 *     client-side.
 *
 * Tone: enterprise / SOC. No emoji, no playful copy. The header carries
 * a compliance-grade tagline; mutating buttons read PAUSE / SUPERSEDE /
 * ARCHIVE — explicit verbs.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";

type PolicyStatus = "ACTIVE" | "PAUSED" | "SUPERSEDED" | "ARCHIVED";
type PolicyScope = "WORKSPACE" | "EVIDENCE_TYPE" | "CASE" | "REGULATORY";

type Policy = {
  id: string;
  teamId: string;
  displayName: string;
  description: string | null;
  status: PolicyStatus;
  scope: PolicyScope;
  scopeQualifier: string | null;
  caseId: string | null;
  retentionDays: number | null;
  immutable: boolean;
  autoExtensionEnabled: boolean;
  autoExtensionDays: number | null;
  supersededByPolicyId: string | null;
  currentVersion: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAtUtc: string | null;
};

type Version = {
  version: number;
  retentionDays: number | null;
  immutable: boolean;
  diffJson: unknown;
  authoredByUserId: string;
  changeNote: string | null;
  authoredAtUtc: string;
};

const STATUS_LABEL: Record<PolicyStatus, string> = {
  ACTIVE: "Active",
  PAUSED: "Paused",
  SUPERSEDED: "Superseded",
  ARCHIVED: "Archived",
};

const SCOPE_LABEL: Record<PolicyScope, string> = {
  WORKSPACE: "Workspace",
  EVIDENCE_TYPE: "Evidence type",
  CASE: "Case",
  REGULATORY: "Regulatory",
};

export default function RetentionPoliciesPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | "ALL">("ALL");
  const [selectedVersionsFor, setSelectedVersionsFor] = useState<string | null>(
    null,
  );
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((res: { user?: { currentWorkspaceId?: string | null } }) => {
        if (cancelled) return;
        setTeamId(res?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => setTeamId(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const status = statusFilter === "ALL" ? "" : `&status=${statusFilter}`;
    apiFetch(
      `/v1/governance/retention-policies?teamId=${encodeURIComponent(teamId)}${status}`,
      { method: "GET" },
    )
      .then((res: { policies: Policy[] }) => {
        if (cancelled) return;
        setPolicies(res.policies);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Unable to load policies.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, statusFilter]);

  async function refresh() {
    if (!teamId) return;
    const status = statusFilter === "ALL" ? "" : `&status=${statusFilter}`;
    const res: { policies: Policy[] } = await apiFetch(
      `/v1/governance/retention-policies?teamId=${encodeURIComponent(teamId)}${status}`,
      { method: "GET" },
    );
    setPolicies(res.policies);
  }

  async function loadVersions(policyId: string) {
    if (!teamId) return;
    setSelectedVersionsFor(policyId);
    setVersions(null);
    try {
      const res: { versions: Version[] } = await apiFetch(
        `/v1/governance/retention-policies/${policyId}/versions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      );
      setVersions(res.versions);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not load policy versions.");
      setSelectedVersionsFor(null);
    }
  }

  async function transition(
    policy: Policy,
    nextStatus: PolicyStatus,
  ): Promise<void> {
    if (!teamId) return;
    const note = window.prompt(
      `Change note for ${nextStatus} — required for audit trail.`,
    );
    if (!note || !note.trim()) return;
    try {
      await apiFetch(
        `/v1/governance/retention-policies/${policy.id}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            nextStatus,
            changeNote: note.trim(),
          }),
        },
      );
      await refresh();
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? `Could not transition policy to ${nextStatus}.`);
    }
  }

  const visiblePolicies = useMemo(() => policies ?? [], [policies]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Retention policies</h1>
        <p style={mutedStyle}>
          Versioned retention rules. Most-specific scope wins (CASE →
          EVIDENCE_TYPE → REGULATORY → WORKSPACE). Mutations are
          append-only — every change writes a new immutable version row.
        </p>
      </header>

      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/destruction" style={navLinkStyle}>
          Destruction queue →
        </Link>
      </nav>

      <div style={toolbarStyle}>
        <label style={filterLabelStyle}>
          Status
          <select
            style={inputStyle}
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as PolicyStatus | "ALL")
            }
          >
            <option value="ALL">All</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="SUPERSEDED">Superseded</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </label>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => setShowCreate(true)}
          disabled={!teamId}
        >
          New policy
        </button>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to manage policies.</p>
      ) : !policies ? (
        <p style={mutedStyle}>Loading policies…</p>
      ) : visiblePolicies.length === 0 ? (
        <p style={mutedStyle}>No policies match the current filter.</p>
      ) : (
        <section style={cardStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Policy</th>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Retention</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Version</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visiblePolicies.map((p) => (
                <tr key={p.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{p.displayName}</div>
                    {p.description ? (
                      <div style={mutedStyle}>{p.description}</div>
                    ) : null}
                    {p.immutable ? (
                      <span style={immutableBadgeStyle}>Immutable</span>
                    ) : null}
                    {p.autoExtensionEnabled ? (
                      <span style={autoExtendBadgeStyle}>Auto-extend</span>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    {SCOPE_LABEL[p.scope]}
                    {p.scopeQualifier ? (
                      <div style={mutedStyle}>{p.scopeQualifier}</div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    {p.retentionDays === null
                      ? "Indefinite"
                      : `${p.retentionDays.toLocaleString()} days`}
                  </td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(p.status)}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </td>
                  <td style={tdStyle}>v{p.currentVersion}</td>
                  <td style={tdStyle}>
                    <div style={actionRowStyle}>
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={() => loadVersions(p.id)}
                      >
                        Versions
                      </button>
                      {p.status === "ACTIVE" ? (
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          onClick={() => transition(p, "PAUSED")}
                        >
                          Pause
                        </button>
                      ) : null}
                      {p.status === "PAUSED" ? (
                        <button
                          type="button"
                          style={secondaryButtonStyle}
                          onClick={() => transition(p, "ACTIVE")}
                        >
                          Resume
                        </button>
                      ) : null}
                      {p.status === "ACTIVE" || p.status === "PAUSED" ? (
                        <>
                          <button
                            type="button"
                            style={secondaryButtonStyle}
                            onClick={() => transition(p, "SUPERSEDED")}
                          >
                            Supersede
                          </button>
                          <button
                            type="button"
                            style={dangerButtonStyle}
                            onClick={() => transition(p, "ARCHIVED")}
                          >
                            Archive
                          </button>
                        </>
                      ) : null}
                      {p.status === "SUPERSEDED" ? (
                        <button
                          type="button"
                          style={dangerButtonStyle}
                          onClick={() => transition(p, "ARCHIVED")}
                        >
                          Archive
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {selectedVersionsFor ? (
        <VersionsModal
          versions={versions}
          onClose={() => {
            setSelectedVersionsFor(null);
            setVersions(null);
          }}
        />
      ) : null}

      {showCreate && teamId ? (
        <CreatePolicyModal
          teamId={teamId}
          onCancel={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refresh();
          }}
        />
      ) : null}
    </main>
  );
}

function VersionsModal({
  versions,
  onClose,
}: {
  versions: Version[] | null;
  onClose: () => void;
}) {
  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 720 }}>
        <h3 style={sectionTitleStyle}>Policy versions</h3>
        <p style={{ ...mutedStyle, marginBottom: 12 }}>
          Append-only history. Each row is the snapshot of the policy at that
          version, with the structured diff against the previous version.
        </p>
        {!versions ? (
          <p style={mutedStyle}>Loading versions…</p>
        ) : versions.length === 0 ? (
          <p style={mutedStyle}>No versions to show.</p>
        ) : (
          <ul style={listStyle}>
            {versions.map((v) => (
              <li key={v.version} style={versionRowStyle}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <strong>v{v.version}</strong>
                  <span style={mutedStyle}>
                    {new Date(v.authoredAtUtc).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Retention:{" "}
                  <strong>
                    {v.retentionDays === null
                      ? "Indefinite"
                      : `${v.retentionDays} days`}
                  </strong>
                  {v.immutable ? (
                    <span style={{ marginLeft: 8 }}>· Immutable</span>
                  ) : null}
                </div>
                {v.changeNote ? (
                  <div style={mutedStyle}>{v.changeNote}</div>
                ) : null}
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: "#475569" }}>
                    Structured diff
                  </summary>
                  <pre style={preStyle}>
                    {JSON.stringify(v.diffJson, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CreatePolicyModal({
  teamId,
  onCancel,
  onCreated,
}: {
  teamId: string;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<PolicyScope>("WORKSPACE");
  const [scopeQualifier, setScopeQualifier] = useState("");
  const [caseId, setCaseId] = useState("");
  const [retentionDays, setRetentionDays] = useState<string>("");
  const [immutable, setImmutable] = useState(false);
  const [autoExtensionEnabled, setAutoExtensionEnabled] = useState(false);
  const [autoExtensionDays, setAutoExtensionDays] = useState<string>("");
  const [changeNote, setChangeNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        teamId,
        displayName: displayName.trim(),
        description: description.trim() ? description.trim() : null,
        scope,
        scopeQualifier:
          scope === "EVIDENCE_TYPE" || scope === "REGULATORY"
            ? scopeQualifier.trim() || null
            : null,
        caseId: scope === "CASE" ? caseId.trim() || null : null,
        retentionDays: retentionDays.trim() ? Number(retentionDays) : null,
        immutable,
        autoExtensionEnabled,
        autoExtensionDays:
          autoExtensionEnabled && autoExtensionDays.trim()
            ? Number(autoExtensionDays)
            : null,
        changeNote: changeNote.trim() || undefined,
      };
      await apiFetch("/v1/governance/retention-policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await onCreated();
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not create policy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={{ ...modalStyle, maxWidth: 560 }}>
        <h3 style={sectionTitleStyle}>New retention policy</h3>

        <Field label="Display name">
          <input
            style={inputStyle}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, 180))}
            placeholder="e.g. EU GDPR Standard 30d"
            autoFocus
          />
        </Field>

        <Field label="Description (operator-readable only)">
          <textarea
            style={{ ...inputStyle, minHeight: 60 }}
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            placeholder="Optional description. Never store privileged legal text."
          />
        </Field>

        <Field label="Scope">
          <select
            style={inputStyle}
            value={scope}
            onChange={(e) => setScope(e.target.value as PolicyScope)}
          >
            <option value="WORKSPACE">Workspace</option>
            <option value="EVIDENCE_TYPE">Evidence type</option>
            <option value="CASE">Case</option>
            <option value="REGULATORY">Regulatory</option>
          </select>
        </Field>

        {scope === "EVIDENCE_TYPE" ? (
          <Field label="Evidence type qualifier">
            <input
              style={inputStyle}
              value={scopeQualifier}
              onChange={(e) =>
                setScopeQualifier(e.target.value.slice(0, 40))
              }
              placeholder="PHOTO | VIDEO | AUDIO | DOCUMENT"
            />
          </Field>
        ) : null}

        {scope === "REGULATORY" ? (
          <Field label="Jurisdiction code">
            <input
              style={inputStyle}
              value={scopeQualifier}
              onChange={(e) =>
                setScopeQualifier(e.target.value.slice(0, 40))
              }
              placeholder="e.g. EU, US-NY, UK"
            />
          </Field>
        ) : null}

        {scope === "CASE" ? (
          <Field label="Case ID">
            <input
              style={inputStyle}
              value={caseId}
              onChange={(e) => setCaseId(e.target.value.trim())}
              placeholder="uuid"
            />
          </Field>
        ) : null}

        <Field label="Retention (days). Empty = indefinite.">
          <input
            type="number"
            min={0}
            max={36500}
            style={inputStyle}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </Field>

        <Toggle
          label="Immutable — block destruction even after expiry"
          value={immutable}
          onChange={setImmutable}
        />
        <Toggle
          label="Auto-extend on custody activity"
          value={autoExtensionEnabled}
          onChange={setAutoExtensionEnabled}
        />
        {autoExtensionEnabled ? (
          <Field label="Auto-extension window (days)">
            <input
              type="number"
              min={1}
              max={36500}
              style={inputStyle}
              value={autoExtensionDays}
              onChange={(e) => setAutoExtensionDays(e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Change note (required for audit)">
          <input
            style={inputStyle}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value.slice(0, 2000))}
            placeholder="Initial policy"
          />
        </Field>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button type="button" style={secondaryButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy || !displayName.trim()}
            onClick={submit}
          >
            {busy ? "Creating…" : "Create policy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={fieldLabelStyle}>
      <div style={fieldLabelTextStyle}>{label}</div>
      {children}
    </label>
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
    <label style={toggleStyle}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  marginBottom: 4,
  letterSpacing: -0.4,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 8,
};
const cardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 0,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
  overflow: "hidden",
};
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 16,
  marginBottom: 8,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 16,
  marginBottom: 12,
};
const filterLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#475569",
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
  width: "100%",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#475569",
};
const tdStyle: React.CSSProperties = {
  padding: "14px 16px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontWeight: 600,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 12,
};
const fieldLabelTextStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#334155",
  marginBottom: 4,
};
const toggleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 12,
  fontSize: 14,
  color: "#334155",
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
  overflow: "auto",
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  width: "100%",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
  maxHeight: "90vh",
  overflow: "auto",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "12px 0 0",
};
const versionRowStyle: React.CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid #f1f5f9",
};
const preStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  background: "#f8fafc",
  padding: 10,
  borderRadius: 6,
  border: "1px solid #e2e8f0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginTop: 4,
};
const immutableBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 4,
  marginRight: 4,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#f5f3ff",
  border: "1px solid #ddd6fe",
  color: "#5b21b6",
  borderRadius: 999,
};
const autoExtendBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 4,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e40af",
  borderRadius: 999,
};

function statusBadgeStyle(status: PolicyStatus): React.CSSProperties {
  const palette: Record<PolicyStatus, [string, string, string]> = {
    ACTIVE: ["#ecfdf5", "#bbf7d0", "#166534"],
    PAUSED: ["#fffbeb", "#fcd34d", "#92400e"],
    SUPERSEDED: ["#eef2ff", "#c7d2fe", "#3730a3"],
    ARCHIVED: ["#f8fafc", "#e2e8f0", "#475569"],
  };
  const [bg, border, color] = palette[status];
  return {
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}
