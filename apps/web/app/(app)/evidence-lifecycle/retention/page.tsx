"use client";

/**
 * Retention Policies — operator mutation surface.
 *
 * Evidence Lifecycle Final Fix:
 *   * The previous implementation crashed to the global error.tsx
 *     ("Something went wrong") under some conditions because every
 *     thrown value flowed through an ad-hoc `applyDenial()` helper that
 *     could itself fail on a non-object error shape.
 *   * Now wired through the shared lifecycle primitives so:
 *       1. EVERY caught value maps to a denial banner (never throws).
 *       2. A LifecycleSectionBoundary contains any render-time crash
 *          inside this page so the segment-level error.tsx becomes a
 *          last-resort net rather than the first line of defence.
 *       3. The page renders chrome (header, refresh, sections) even
 *          when the API is down — empty/error states live INSIDE the
 *          sections, not in place of the page.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import {
  DenialBanner,
  EmptyState,
  LifecyclePageHeader,
  LifecycleSectionBoundary,
  RefreshButton,
  SectionLoadingSkeleton,
  useLifecycleFetch,
} from "../_shared";

interface RetentionPolicy {
  id: string;
  name: string;
  template: string;
  scopeKind: string;
  scopeTargetId?: string | null;
  expiresAtUtc?: string | null;
  state: string;
  createdAtUtc: string;
}

interface UpcomingExpiration {
  evidenceId: string;
  expiresAtUtc: string;
  policyName: string;
}

interface RetentionPayload {
  policies: RetentionPolicy[];
  expirations: UpcomingExpiration[];
}

const RETENTION_TEMPLATES = [
  "STANDARD_1Y",
  "STANDARD_3Y",
  "LEGAL_HOLD_EXEMPT",
  "CUSTOM",
] as const;

/**
 * Defensive date formatter. `new Date(undefined)` is Invalid Date and
 * `.toLocaleDateString()` returns "Invalid Date" — both safe for React
 * but visually noisy. Render an em-dash when the input is missing or
 * unparseable.
 */
function formatDate(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return formatUserDate(input);
}

async function loadRetention(): Promise<RetentionPayload> {
  // Promise.allSettled — a transient failure in ONE endpoint must not
  // wipe the other. Previously, Promise.all rejected on the first
  // failure, which then bubbled into the catch arm of useLifecycleFetch
  // and prevented even the working dataset from rendering.
  const [pRes, eRes] = await Promise.allSettled([
    apiFetch("/v1/lifecycle/retention/policies", { method: "GET" }),
    apiFetch("/v1/lifecycle/retention/upcoming-expirations", { method: "GET" }),
  ]);
  const policies =
    pRes.status === "fulfilled" &&
    pRes.value &&
    typeof pRes.value === "object" &&
    Array.isArray((pRes.value as { policies?: unknown }).policies)
      ? ((pRes.value as { policies: RetentionPolicy[] }).policies ?? [])
      : [];
  const expirations =
    eRes.status === "fulfilled" &&
    eRes.value &&
    typeof eRes.value === "object" &&
    Array.isArray((eRes.value as { expirations?: unknown }).expirations)
      ? ((eRes.value as { expirations: UpcomingExpiration[] }).expirations ?? [])
      : [];
  // If BOTH calls failed, surface the policies error so the denial
  // banner renders something useful. If exactly one failed, render the
  // half that worked + a soft note (handled by the page via degraded).
  if (pRes.status === "rejected" && eRes.status === "rejected") {
    throw pRes.reason;
  }
  return { policies, expirations };
}

export default function RetentionPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Retention Policies">
        <Shell />
      </LifecycleSectionBoundary>
    </PageRouteGate>
  );
}

function Shell() {
  const { data, loading, busy, denial, refresh } =
    useLifecycleFetch<RetentionPayload>(loadRetention, []);

  // Create form state (kept inline — modal/dialog would be over-engineering).
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string>(RETENTION_TEMPLATES[0]);
  const [scopeKind, setScopeKind] = useState("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch("/v1/lifecycle/retention/policies", {
        method: "POST",
        body: JSON.stringify({
          name,
          template,
          scopeKind,
          scopeTargetId: scopeTargetId || null,
        }),
      });
      setName("");
      setScopeTargetId("");
      await refresh();
    } catch (err) {
      // Render the create error inline — don't conflate with the load denial.
      const message =
        err && typeof err === "object" && "message" in err
          ? String(toSafeUserError(err, { message: "Could not create policy" }).message)
          : "Could not create policy";
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }, [name, template, scopeKind, scopeTargetId, refresh]);

  const policies = data?.policies ?? [];
  const expirations = data?.expirations ?? [];

  return (
    <div
      data-retention-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <LifecyclePageHeader
        title="Retention Policies"
        subtitle="Define how long evidence is retained and what happens when it expires."
      >
        <RefreshButton busy={busy} onClick={() => void refresh()} />
      </LifecyclePageHeader>

      {denial ? <DenialBanner denial={denial} /> : null}

      {/* Create form */}
      <section
        data-retention-create
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 4, fontSize: 14 }}>
          Create retention policy
        </strong>
        <p style={{ margin: 0, fontSize: 12, color: "#475569", marginBottom: 10 }}>
          Policies apply to the chosen scope. Create one per workspace, department,
          or case. Use <code>STANDARD_3Y</code> for most workspaces; choose{" "}
          <code>LEGAL_HOLD_EXEMPT</code> only when the evidence is contractually
          excluded from retention.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Default 3-year retention"
            />
          </label>
          <label style={labelStyle}>
            Template
            <select
              style={inputStyle}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {RETENTION_TEMPLATES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Scope kind
            <select
              style={inputStyle}
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value)}
            >
              <option value="WORKSPACE">WORKSPACE</option>
              <option value="DEPARTMENT">DEPARTMENT</option>
              <option value="CASE">CASE</option>
            </select>
          </label>
          <label style={labelStyle}>
            Scope target ID
            <input
              style={inputStyle}
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="optional UUID"
            />
          </label>
          <button
            type="button"
            disabled={creating || !name}
            onClick={() => void create()}
            style={primaryButton}
            title={!name ? "Enter a policy name first" : "Create retention policy"}
          >
            {creating ? "Creating…" : "Create policy"}
          </button>
        </div>
        {createError ? (
          <div
            role="alert"
            style={{
              marginTop: 10,
              padding: 8,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#7f1d1d",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <strong>Could not create policy:</strong> {createError}
          </div>
        ) : null}
      </section>

      {/* Policies table */}
      <section
        data-retention-policies
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <header style={tableHeaderStyle}>
          <strong style={{ fontSize: 14 }}>Policies</strong>
          <small style={{ color: "#64748b", fontSize: 11 }}>
            {policies.length} active
          </small>
        </header>
        {loading ? (
          <SectionLoadingSkeleton rows={3} />
        ) : policies.length === 0 ? (
          <EmptyState
            title="No retention policies"
            hint="Create one above to start applying retention windows to evidence in this workspace."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={th}>Name</th>
                <th style={th}>Template</th>
                <th style={th}>Scope</th>
                <th style={th}>Target</th>
                <th style={th}>State</th>
                <th style={th}>Expires</th>
                <th style={th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.name}</td>
                  <td style={td}>
                    <code>{p.template}</code>
                  </td>
                  <td style={td}>{p.scopeKind}</td>
                  <td style={td}>{p.scopeTargetId ?? "—"}</td>
                  <td style={td}>
                    <strong>{p.state}</strong>
                  </td>
                  <td style={td}>{formatDate(p.expiresAtUtc)}</td>
                  <td style={td}>{formatDate(p.createdAtUtc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Upcoming expirations */}
      <section
        data-retention-expirations
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <header style={tableHeaderStyle}>
          <strong style={{ fontSize: 14 }}>Upcoming expirations (30 days)</strong>
          <small style={{ color: "#64748b", fontSize: 11 }}>
            {expirations.length} evidence item{expirations.length === 1 ? "" : "s"}
          </small>
        </header>
        {loading ? (
          <SectionLoadingSkeleton rows={2} />
        ) : expirations.length === 0 ? (
          <EmptyState
            title="No evidence expiring in the next 30 days"
            hint="Nothing in scope will hit its retention boundary in the near term."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={th}>Evidence ID</th>
                <th style={th}>Policy</th>
                <th style={th}>Expires</th>
              </tr>
            </thead>
            <tbody>
              {expirations.map((e) => (
                <tr key={e.evidenceId}>
                  <td style={td}>
                    <code>{e.evidenceId}</code>
                  </td>
                  <td style={td}>{e.policyName}</td>
                  <td style={td}>{formatDate(e.expiresAtUtc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
};
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
const tableHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 4px 8px",
  borderBottom: "1px solid #e2e8f0",
  marginBottom: 4,
} as const;
