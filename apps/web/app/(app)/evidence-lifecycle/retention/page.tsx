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
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
// PHASE 7 §10 — canonical context-safety primitives.
import {
  WorkspaceContextBanner,
  useWorkspaceContextSafety,
} from "../../../../lib/platform-context";
import { formatUserDate } from "../../../../lib/date";
import {
  DenialBanner,
  LifecycleSectionBoundary,
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

// Template values must match the contract enum RETENTION_POLICY_TEMPLATES
// validated by the retention engine (retention-engine.service.ts). Sending an
// unknown template returns POLICY_REJECTED (409). CUSTOM requires an explicit
// `years` value in the request body.
const RETENTION_TEMPLATES = [
  "INSURANCE_7Y",
  "JOURNALISM_10Y",
  "CORPORATE_5Y",
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
  // CUSTOM requires an explicit retention window; other templates carry
  // their own default years server-side.
  const [years, setYears] = useState("");
  const [scopeKind, setScopeKind] = useState("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // PHASE 7 §10.1/§10.3 — unsaved policy form is dirty work; guard create
  // against a mid-flight workspace switch.
  const { runGuarded } = useWorkspaceContextSafety({
    isDirty:
      name.trim().length > 0 ||
      years.trim().length > 0 ||
      scopeTargetId.trim().length > 0,
    dirtyLabel: "Unsaved retention policy",
  });

  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await runGuarded(
        () =>
          apiFetch("/v1/lifecycle/retention/policies", {
            method: "POST",
            body: JSON.stringify({
              name,
              template,
              // CUSTOM has no server default — send the operator window.
              ...(template === "CUSTOM" && years
                ? { years: Number.parseInt(years, 10) }
                : {}),
              scopeKind,
              scopeTargetId: scopeTargetId || null,
            }),
          }),
        () => {
          setName("");
          setYears("");
          setScopeTargetId("");
          void refresh();
        },
      );
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
  }, [name, template, years, scopeKind, scopeTargetId, refresh, runGuarded]);

  const policies = data?.policies ?? [];
  const expirations = data?.expirations ?? [];

  return (
    <PageShell
      data-retention-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Retention Policies"
          subtitle="Define how long evidence is retained and what happens when it expires."
          primaryAction={
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
          contextStrip={
            <a
              href="/evidence-lifecycle"
              style={{
                fontSize: 12,
                color: "#4338ca",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              ← Back to Lifecycle Operations
            </a>
          }
        />
      }
    >
      {denial ? <DenialBanner denial={denial} /> : null}

      {/* PHASE 7 §10.5 — retention governs custody; show owning context. */}
      <WorkspaceContextBanner action="This retention policy will apply in" />

      {/* Create form */}
      <Card
        variant="admin"
        data-retention-create
        title="Create retention policy"
      >
        <p style={{ margin: 0, fontSize: 12, color: "#475569", marginBottom: 10 }}>
          Policies apply to the chosen scope. Create one per workspace, department,
          or case. Use <code>CORPORATE_5Y</code> for most workspaces, or{" "}
          <code>CUSTOM</code> with an explicit number of years for a bespoke
          retention window.
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
          {template === "CUSTOM" ? (
            <label style={labelStyle}>
              Years
              <input
                type="number"
                min={1}
                max={100}
                style={inputStyle}
                value={years}
                onChange={(e) => setYears(e.target.value)}
                placeholder="e.g. 4"
              />
            </label>
          ) : null}
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
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !name || (template === "CUSTOM" && !years)}
            onClick={() => void create()}
            title={
              !name
                ? "Enter a policy name first"
                : template === "CUSTOM" && !years
                  ? "Enter the number of years for a CUSTOM policy"
                  : "Create retention policy"
            }
          >
            {creating ? "Creating…" : "Create policy"}
          </Button>
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
      </Card>

      {/* Policies table */}
      <PageSection
        data-retention-policies
        title="Policies"
        action={
          <small style={{ color: "#64748b", fontSize: 11 }}>
            {policies.length} active
          </small>
        }
      >
        {loading ? (
          <Card padding="compact">
            <SectionLoadingSkeleton rows={3} />
          </Card>
        ) : (
          <DataTable<RetentionPolicy>
            ariaLabel="Retention policies"
            columns={POLICY_COLUMNS}
            rows={policies}
            getRowId={(p) => p.id}
            emptyState={
              <EmptyState
                title="No retention policy configured"
                purpose="Create a policy above to start applying retention windows to evidence in this workspace."
              />
            }
          />
        )}
      </PageSection>

      {/* Upcoming expirations */}
      <PageSection
        data-retention-expirations
        title="Upcoming expirations (30 days)"
        action={
          <small style={{ color: "#64748b", fontSize: 11 }}>
            {expirations.length} evidence item{expirations.length === 1 ? "" : "s"}
          </small>
        }
      >
        {loading ? (
          <Card padding="compact">
            <SectionLoadingSkeleton rows={2} />
          </Card>
        ) : (
          <DataTable<UpcomingExpiration>
            ariaLabel="Upcoming expirations"
            columns={EXPIRATION_COLUMNS}
            rows={expirations}
            getRowId={(e) => e.evidenceId}
            emptyState={
              <EmptyState
                title="No evidence expiring in the next 30 days"
                purpose="Nothing in scope will hit its retention boundary in the near term."
              />
            }
          />
        )}
      </PageSection>
    </PageShell>
  );
}

const POLICY_COLUMNS: DataTableColumn<RetentionPolicy>[] = [
  { key: "name", header: "Name", render: (p) => p.name },
  { key: "template", header: "Template", render: (p) => <code>{p.template}</code> },
  { key: "scope", header: "Scope", render: (p) => p.scopeKind },
  { key: "target", header: "Target", render: (p) => p.scopeTargetId ?? "—" },
  { key: "state", header: "State", render: (p) => <strong>{p.state}</strong> },
  { key: "expires", header: "Expires", render: (p) => formatDate(p.expiresAtUtc) },
  { key: "created", header: "Created", render: (p) => formatDate(p.createdAtUtc) },
];

const EXPIRATION_COLUMNS: DataTableColumn<UpcomingExpiration>[] = [
  { key: "evidenceId", header: "Evidence ID", render: (e) => <code>{e.evidenceId}</code> },
  { key: "policy", header: "Policy", render: (e) => e.policyName },
  { key: "expires", header: "Expires", render: (e) => formatDate(e.expiresAtUtc) },
];

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
