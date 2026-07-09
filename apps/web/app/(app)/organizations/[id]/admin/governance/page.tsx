"use client";

/**
 * Phase 5 (Enterprise Governance) — Org admin / Governance Control Center.
 *
 * The canonical evidence-Governance Control Center for an organization.
 * Renders REAL org-scoped governance posture from a single read-only
 * aggregate — GET /v1/orgs/:id/governance/control-center — which spans
 * the org's non-personal workspaces and projects: active legal holds
 * (count + list + evidence-under-hold), active retention policies,
 * pending destruction reviews, active external-review grants (external
 * sharing under governance), recent org governance audit, and derived
 * retention / legal-hold coverage + chain-of-custody health indicators.
 *
 * Honest by construction:
 *   - Every metric comes from real reads. Where a signal isn't modeled
 *     or a section degrades server-side, we render an honest
 *     "unavailable" / empty state — NEVER a fabricated number.
 *   - Report/package "generated" counts have no org-scoped count
 *     endpoint, so they are intentionally OMITTED rather than faked.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">
 *     (enterprise-only via the /organizations path-prefix tier + org
 *     membership; the backend re-gates the aggregate at ORG_AUDITOR+).
 *   - Read-only: no mutating apiFetch verbs, no window.confirm.
 *   - toSafeUserError is the only non-ApiError display path.
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - Governance policy CRUD is NOT duplicated here; the control center
 *     deep-links to the canonical mutation surfaces.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Badge / Button / PageSection / EmptyState). This tab
 * renders INSIDE the org admin layout shell (which owns the org title +
 * tab bar), so it uses PageSection headings — not a second PageHeader —
 * to avoid a duplicate <h1>. All data reads, gating, testids, data-state
 * markers and honest "—"/unavailable behaviour are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { formatUtcAuditDateTime } from "../../../../../../lib/date";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";

// ---------------------------------------------------------------------------
// Wire types — mirror GET /v1/orgs/:id/governance/control-center.
// ---------------------------------------------------------------------------

type SectionStatus = "ok" | "degraded" | "unavailable";

interface ControlCenterResponse {
  organizationId: string;
  generatedAt: string;
  scope: { workspaceCount: number };
  sections: {
    legalHolds: {
      status: SectionStatus;
      data: {
        activeCount: number;
        activeCaseHoldCount: number;
        evidenceUnderHoldCount: number;
        sample: Array<{
          id: string;
          teamId: string;
          evidenceId: string;
          title: string;
          reason: string | null;
          placedAtUtc: string;
        }>;
      } | null;
    };
    retention: {
      status: SectionStatus;
      data: {
        activePolicyCount: number;
        workspacesWithPolicyCount: number;
        orgTemplatePublished: boolean;
        sample: Array<{
          id: string;
          teamId: string;
          displayName: string;
          scope: string;
          retentionDays: number | null;
          immutable: boolean;
        }>;
      } | null;
    };
    destruction: {
      status: SectionStatus;
      data: {
        pendingCount: number;
        sample: Array<{
          id: string;
          teamId: string;
          evidenceId: string;
          status: string;
          reason: string;
          createdAt: string;
        }>;
      } | null;
    };
    externalSharing: {
      status: SectionStatus;
      data: { activeGrantCount: number } | null;
    };
    audit: {
      status: SectionStatus;
      data: {
        recentCount: number;
        events: Array<{
          id: string;
          eventType: string;
          targetType: string | null;
          createdAt: string;
        }>;
      } | null;
    };
    coverage: {
      status: SectionStatus;
      data: {
        workspaceCount: number;
        retentionCoveredWorkspaceCount: number;
        orgTemplatePublished: boolean;
        legalHoldActive: boolean;
        pendingDestructionCount: number;
      } | null;
    };
  };
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export default function OrganizationAdminGovernancePage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <GovernanceControlCenter />
    </PageRouteGate>
  );
}

function GovernanceControlCenter() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [state, setState] = useState<Loadable<ControlCenterResponse>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/orgs/${orgId}/governance/control-center`,
      )) as ControlCenterResponse;
      setState({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = toSafeUserError(err, {
          message: "Failed to load the governance control center.",
        }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = state.kind === "ready" ? state.data.sections : null;

  return (
    <section
      data-testid="org-admin-governance"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* -------------------------------------------------------------
          Header — what this control center is.
          ------------------------------------------------------------- */}
      <Card
        variant="status"
        tone="governance"
        data-section="governance-intro"
        title="Governance Control Center"
        headerAction={<Badge tone="governance" dot>Read-only</Badge>}
      >
        <p style={mutedText}>
          A read-only view of evidence-governance posture across every
          workspace in this organization: legal holds preserving evidence,
          retention policies in force, destruction reviews awaiting a
          decision, external sharing under governance, and recent
          governance activity. Mutation lives on the canonical surfaces
          linked below.
        </p>
        {state.kind === "ready" ? (
          <p
            data-testid="governance-scope"
            style={{ ...subtleText, marginTop: 8 }}
          >
            Spanning {state.data.scope.workspaceCount} workspace
            {state.data.scope.workspaceCount === 1 ? "" : "s"} bound to this
            organization.
          </p>
        ) : null}
      </Card>

      {state.kind === "loading" ? (
        <Card variant="admin" data-state="loading">
          <span style={subtleText}>Loading governance posture…</span>
        </Card>
      ) : state.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          data-state="error"
          data-testid="governance-error"
          role="alert"
        >
          <div style={{ fontSize: 13.5, color: "var(--ink-primary, #0f172a)" }}>
            {state.status === 403 || state.status === 404
              ? "You don't have access to the organization governance control center. This view requires ORG_AUDITOR or higher."
              : state.message}
          </div>
          {state.requestId ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                fontFamily: "monospace",
                color: "var(--ink-muted, #94a3b8)",
              }}
            >
              Request id: {state.requestId}
            </div>
          ) : null}
        </Card>
      ) : sections ? (
        <>
          {/* ---------------------------------------------------------
              KPI tiles — the headline governance counts.
              --------------------------------------------------------- */}
          <div
            data-section="governance-kpis"
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            }}
          >
            <Kpi
              testId="kpi-active-legal-holds"
              label="Active legal holds"
              value={kpiValue(
                sections.legalHolds.status,
                sections.legalHolds.data?.activeCount,
              )}
              secondary={
                sections.legalHolds.data
                  ? `${sections.legalHolds.data.evidenceUnderHoldCount} evidence record${
                      sections.legalHolds.data.evidenceUnderHoldCount === 1
                        ? ""
                        : "s"
                    } under hold`
                  : "Preservation signal unavailable"
              }
            />
            <Kpi
              testId="kpi-retention-policies"
              label="Active retention policies"
              value={kpiValue(
                sections.retention.status,
                sections.retention.data?.activePolicyCount,
              )}
              secondary={
                sections.retention.data
                  ? `${sections.retention.data.workspacesWithPolicyCount} workspace${
                      sections.retention.data.workspacesWithPolicyCount === 1
                        ? ""
                        : "s"
                    } covered`
                  : "Retention signal unavailable"
              }
            />
            <Kpi
              testId="kpi-pending-destruction"
              label="Destruction reviews pending"
              value={kpiValue(
                sections.destruction.status,
                sections.destruction.data?.pendingCount,
              )}
              secondary="Awaiting an approval decision"
            />
            <Kpi
              testId="kpi-external-grants"
              label="Active external-review grants"
              value={kpiValue(
                sections.externalSharing.status,
                sections.externalSharing.data?.activeGrantCount,
              )}
              secondary="External sharing under governance"
            />
          </div>

          {/* ---------------------------------------------------------
              Coverage / chain-of-custody health indicators.
              --------------------------------------------------------- */}
          <CoverageSection
            orgId={orgId}
            coverage={sections.coverage}
            legalHoldStatus={sections.legalHolds.status}
          />

          {/* ---------------------------------------------------------
              Active legal holds — list.
              --------------------------------------------------------- */}
          <ListSection
            testId="section-legal-holds"
            title="Active legal holds"
            status={sections.legalHolds.status}
            empty={
              !!sections.legalHolds.data &&
              sections.legalHolds.data.sample.length === 0
            }
            emptyLabel="No active legal holds across this organization's workspaces."
            footer={
              <DeepLink
                testId="gov-link-legal-holds"
                label="Evidence Lifecycle · Legal holds"
                href="/evidence-lifecycle/legal-holds"
              />
            }
          >
            {sections.legalHolds.data?.sample.map((h) => (
              <li key={h.id} data-testid="legal-hold-row" style={rowStyle}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 600 }}>{h.title}</div>
                  <div style={subtleText}>
                    Evidence {h.evidenceId.slice(0, 8)}… · placed{" "}
                    {formatUtcAuditDateTime(h.placedAtUtc)}
                    {h.reason ? ` · ${h.reason}` : ""}
                  </div>
                </div>
                <Link
                  href={`/evidence/${h.evidenceId}`}
                  data-testid="legal-hold-evidence-link"
                  style={linkReset}
                >
                  <Button variant="ghost" size="sm">
                    Open evidence →
                  </Button>
                </Link>
              </li>
            ))}
          </ListSection>

          {/* ---------------------------------------------------------
              Active retention policies — list.
              --------------------------------------------------------- */}
          <ListSection
            testId="section-retention-policies"
            title="Active retention policies"
            status={sections.retention.status}
            empty={
              !!sections.retention.data &&
              sections.retention.data.sample.length === 0
            }
            emptyLabel="No active workspace retention policies. Publish an org-level retention template on the Retention tab to set a default."
            footer={
              <DeepLink
                testId="gov-link-retention"
                label="Retention & Legal hold tab"
                href={`/organizations/${orgId}/admin/retention`}
              />
            }
          >
            {sections.retention.data?.sample.map((p) => (
              <li key={p.id} data-testid="retention-policy-row" style={rowStyle}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 600 }}>{p.displayName}</div>
                  <div style={subtleText}>
                    {p.scope} ·{" "}
                    {p.retentionDays === null
                      ? "indefinite retention"
                      : `${p.retentionDays} day${p.retentionDays === 1 ? "" : "s"}`}
                    {p.immutable ? " · immutable" : ""}
                  </div>
                </div>
              </li>
            ))}
          </ListSection>

          {/* ---------------------------------------------------------
              Destruction reviews pending — list.
              --------------------------------------------------------- */}
          <ListSection
            testId="section-destruction"
            title="Destruction reviews pending"
            status={sections.destruction.status}
            empty={
              !!sections.destruction.data &&
              sections.destruction.data.sample.length === 0
            }
            emptyLabel="No destruction reviews awaiting a decision."
            footer={
              <DeepLink
                testId="gov-link-destruction"
                label="Evidence Lifecycle · Destruction"
                href="/evidence-lifecycle/destruction"
              />
            }
          >
            {sections.destruction.data?.sample.map((d) => (
              <li key={d.id} data-testid="destruction-row" style={rowStyle}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 600 }}>
                    Evidence {d.evidenceId.slice(0, 8)}…
                  </div>
                  <div style={subtleText}>
                    {d.status} · {d.reason} · opened{" "}
                    {formatUtcAuditDateTime(d.createdAt)}
                  </div>
                </div>
                <Link
                  href={`/evidence/${d.evidenceId}`}
                  data-testid="destruction-evidence-link"
                  style={linkReset}
                >
                  <Button variant="ghost" size="sm">
                    Open evidence →
                  </Button>
                </Link>
              </li>
            ))}
          </ListSection>

          {/* ---------------------------------------------------------
              Recent governance audit — list.
              --------------------------------------------------------- */}
          <ListSection
            testId="section-audit"
            title="Recent governance activity"
            status={sections.audit.status}
            empty={
              !!sections.audit.data && sections.audit.data.events.length === 0
            }
            emptyLabel="No governance audit events recorded yet."
            footer={
              <DeepLink
                testId="gov-link-audit"
                label="Audit tab"
                href={`/organizations/${orgId}/admin/audit`}
              />
            }
          >
            {sections.audit.data?.events.map((e) => (
              <li key={e.id} data-testid="audit-row" style={rowStyle}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 600 }}>{e.eventType}</div>
                  {e.targetType ? (
                    <div style={subtleText}>{e.targetType}</div>
                  ) : null}
                </div>
                <span style={subtleText}>
                  {formatUtcAuditDateTime(e.createdAt)}
                </span>
              </li>
            ))}
          </ListSection>

          {/* ---------------------------------------------------------
              Canonical governance surfaces — deep-links.
              --------------------------------------------------------- */}
          <Card
            variant="admin"
            data-section="governance-deep-links"
            title="Canonical governance surfaces"
            subtitle="This control center is read-only. Each mutation workflow lives on its canonical surface."
          >
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              <DeepLinkRow
                testId="gov-deep-link-retention-tab"
                label="Retention & Legal hold"
                description="Org retention template + legal-hold posture."
                href={`/organizations/${orgId}/admin/retention`}
              />
              <DeepLinkRow
                testId="gov-deep-link-external-reviewers"
                label="External reviewer grants"
                description="Read-only governance view of external-sharing grants: state, scope, expiration, and access audit."
                href={`/organizations/${orgId}/admin/governance/external-reviewers`}
              />
              <DeepLinkRow
                testId="gov-deep-link-access-reviews"
                label="Access reviews"
                description="Active access-review campaigns."
                href={`/organizations/${orgId}/admin/access-reviews`}
              />
              <DeepLinkRow
                testId="gov-deep-link-audit-tab"
                label="Audit"
                description="Full org governance audit timeline."
                href={`/organizations/${orgId}/admin/audit`}
              />
              <DeepLinkRow
                testId="gov-deep-link-lifecycle-legal-holds"
                label="Evidence Lifecycle · Legal holds"
                description="Place, list, and release legal holds (ADMIN+)."
                href="/evidence-lifecycle/legal-holds"
              />
              <DeepLinkRow
                testId="gov-deep-link-lifecycle-destruction"
                label="Evidence Lifecycle · Destruction"
                description="Two-person destruction reviews + executions."
                href="/evidence-lifecycle/destruction"
              />
              <DeepLinkRow
                testId="gov-deep-link-platform"
                label="Governance Platform"
                description="Policies, departments, and delegated administration."
                href="/governance-platform"
              />
            </ul>
          </Card>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Coverage / chain-of-custody health.
// ---------------------------------------------------------------------------

function CoverageSection({
  orgId,
  coverage,
  legalHoldStatus,
}: {
  orgId: string;
  coverage: ControlCenterResponse["sections"]["coverage"];
  legalHoldStatus: SectionStatus;
}) {
  const data = coverage.data;
  const retentionPct =
    data && data.workspaceCount > 0
      ? Math.round(
          (data.retentionCoveredWorkspaceCount / data.workspaceCount) * 100,
        )
      : 0;

  return (
    <Card
      variant="summary"
      data-section="governance-coverage"
      data-testid="section-coverage"
      title="Coverage & custody health"
      subtitle="Retention & legal-hold coverage and chain-of-custody status across the organization. Indicators are derived from live counts — never a synthetic health badge."
    >
      {coverage.status === "unavailable" || !data ? (
        <div
          data-state="unavailable"
          style={unavailableBox}
        >
          Coverage indicators are temporarily unavailable.
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <CoverageRow
            testId="coverage-retention"
            label="Retention coverage"
            pill={
              data.retentionCoveredWorkspaceCount >= data.workspaceCount &&
              data.workspaceCount > 0
                ? { tone: "ok", text: "Full" }
                : data.orgTemplatePublished
                  ? { tone: "ok", text: "Template + partial" }
                  : { tone: "warn", text: `${retentionPct}% of workspaces` }
            }
            description={`${data.retentionCoveredWorkspaceCount} of ${data.workspaceCount} workspace${
              data.workspaceCount === 1 ? "" : "s"
            } have an active retention policy${
              data.orgTemplatePublished
                ? "; an org retention template backs the rest."
                : "; no org template is published."
            }`}
            href={`/organizations/${orgId}/admin/retention`}
            linkLabel="Manage retention"
          />
          <CoverageRow
            testId="coverage-legal-hold"
            label="Legal-hold preservation"
            pill={
              legalHoldStatus === "unavailable"
                ? { tone: "warn", text: "Unavailable" }
                : data.legalHoldActive
                  ? { tone: "ok", text: "Active" }
                  : { tone: "warn", text: "None active" }
            }
            description={
              data.legalHoldActive
                ? "At least one active legal hold is preserving evidence from destruction."
                : "No legal holds are currently preserving evidence."
            }
            href="/evidence-lifecycle/legal-holds"
            linkLabel="Manage legal holds"
          />
          <CoverageRow
            testId="coverage-destruction"
            label="Destruction queue"
            pill={
              data.pendingDestructionCount > 0
                ? { tone: "warn", text: `${data.pendingDestructionCount} pending` }
                : { tone: "ok", text: "Clear" }
            }
            description={
              data.pendingDestructionCount > 0
                ? "Destruction reviews are awaiting a two-person approval decision."
                : "No destruction reviews awaiting a decision."
            }
            href="/evidence-lifecycle/destruction"
            linkLabel="Review destruction queue"
          />
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers.
// ---------------------------------------------------------------------------

const mutedText = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.6,
  color: "var(--ink-secondary, #475569)",
} as const;

const subtleText = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--ink-muted, #94a3b8)",
} as const;

const linkReset = { textDecoration: "none", flexShrink: 0 } as const;

const unavailableBox = {
  padding: "10px 12px",
  border: "1px dashed var(--border-strong, rgba(15,23,42,0.14))",
  borderRadius: 8,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
} as const;

const rowStyle = {
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  fontSize: 13.5,
} as const;

type PillState = { tone: "ok" | "warn"; text: string };

function kpiValue(status: SectionStatus, value: number | undefined): string {
  if (status === "unavailable" || value === undefined) return "—";
  return String(value);
}

function Kpi({
  testId,
  label,
  value,
  secondary,
}: {
  testId: string;
  label: string;
  value: string;
  secondary: string;
}) {
  return (
    <Card variant="summary" padding="compact" data-testid={testId}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 84 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            lineHeight: 1.1,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
          {secondary}
        </div>
      </div>
    </Card>
  );
}

function ListSection({
  testId,
  title,
  status,
  empty,
  emptyLabel,
  footer,
  children,
}: {
  testId: string;
  title: string;
  status: SectionStatus;
  empty: boolean;
  emptyLabel: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card
      variant="summary"
      data-testid={testId}
      data-status={status}
      header={
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 650,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            {title}
          </h2>
          {footer}
        </div>
      }
    >
      {status === "unavailable" ? (
        <div data-state="unavailable" style={unavailableBox}>
          This section is temporarily unavailable.
        </div>
      ) : empty ? (
        <div
          data-state="empty"
          style={{ fontSize: 13.5, color: "var(--ink-secondary, #475569)" }}
        >
          {emptyLabel}
        </div>
      ) : (
        <ul
          style={{ listStyle: "none", padding: 0, margin: 0 }}
          data-state="populated"
        >
          {children}
        </ul>
      )}
    </Card>
  );
}

function CoverageRow({
  testId,
  label,
  pill,
  description,
  href,
  linkLabel,
}: {
  testId: string;
  label: string;
  pill: PillState;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <li
      data-testid={testId}
      data-tone={pill.tone}
      style={{
        padding: "11px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <StatusPill state={pill} />
        </div>
        <div style={{ ...subtleText, marginTop: 2 }}>{description}</div>
      </div>
      <Link href={href} style={linkReset}>
        <Button variant="ghost" size="sm">
          {linkLabel} →
        </Button>
      </Link>
    </li>
  );
}

function StatusPill({ state }: { state: PillState }) {
  return (
    <span data-state={state.tone === "ok" ? "ok" : "not-configured"}>
      <Badge tone={state.tone === "ok" ? "verified" : "pending"} subtle>
        {state.text}
      </Badge>
    </span>
  );
}

function DeepLink({
  testId,
  label,
  href,
}: {
  testId: string;
  label: string;
  href: string;
}) {
  return (
    <Link href={href} data-testid={testId} style={linkReset}>
      <Button variant="ghost" size="sm">
        {label} →
      </Button>
    </Link>
  );
}

function DeepLinkRow({
  testId,
  label,
  description,
  href,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <li
      style={{
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ ...subtleText, marginTop: 2 }}>{description}</div>
      </div>
      <Link href={href} data-testid={testId} style={linkReset}>
        <Button variant="secondary" size="sm">
          Open →
        </Button>
      </Link>
    </li>
  );
}
