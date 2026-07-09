"use client";

/**
 * Phase 4 (Enterprise Administration) — Org admin / API & Integrations tab.
 *
 * The canonical integration platform (API keys + webhooks) is
 * WORKSPACE-scoped: keys and webhook endpoints belong to a Team, and the
 * full developer portal lives at /integrations (apps/web/app/(app)/
 * integrations/page.tsx). This tab does NOT rebuild that portal — it is a
 * thin org-level index that:
 *
 *   - lists the org's workspaces (GET /v1/orgs/:id/workspaces) and
 *     deep-links each into the canonical /integrations surface where an
 *     admin can view / create / revoke / rotate API keys and configure
 *     webhook endpoints (incl. delivery history + failures), and
 *   - documents, read-only, which evidence-relevant webhook events the
 *     backend actually produces today, so an enterprise admin knows what
 *     they can subscribe to WITHOUT inventing events the API cannot emit.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only; all mutations live on /integrations).
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - 403 maps to an honest empty state.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (Card / Button / DataTable / EmptyState). This tab renders INSIDE
 * the org admin layout shell (which owns the org title + tab bar), so it
 * uses Card headings — not a second PageHeader. All data reads, gating,
 * testids, data-section markers, hrefs and event-type strings are unchanged.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";

// ---------------------------------------------------------------------------
// Wire type — mirrors GET /v1/orgs/:id/workspaces (organizations.routes.ts).
// We only need id + name to render the deep-link index.
// ---------------------------------------------------------------------------

interface OrgWorkspace {
  id: string;
  name: string;
}

interface WorkspacesResponse {
  organizationId: string;
  summary: { totalWorkspaces: number };
  workspaces: OrgWorkspace[];
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

/**
 * Evidence-relevant webhook event types that the API actually produces
 * today. Sourced from the canonical producer list in
 * apps/web/app/(app)/integrations/page.tsx (`ALL_EVENT_TYPES`), which is
 * itself pinned to live `emitWebhookEvent` call sites. We deliberately do
 * NOT advertise events with no live producer (e.g. report/package
 * generated are produced by the worker and not yet emitted) — surfacing
 * them here would be inventing capability the backend cannot honor.
 */
const EVIDENCE_WEBHOOK_EVENTS: ReadonlyArray<{
  eventType: string;
  description: string;
}> = [
  {
    eventType: "evidence.created",
    description: "A new evidence record was created in the workspace.",
  },
  {
    eventType: "evidence.completed",
    description: "An evidence record finished processing and is finalized.",
  },
  {
    eventType: "evidence_request.created",
    description: "An evidence request (intake link) was created.",
  },
  {
    eventType: "evidence_request.sent",
    description: "An evidence request was sent to a recipient.",
  },
  {
    eventType: "evidence_request.response_received",
    description: "A recipient responded to an evidence request.",
  },
  {
    eventType: "external_intake.submitted",
    description: "An external contributor submitted evidence via intake.",
  },
  {
    eventType: "governance.legal_hold_placed",
    description: "A legal hold was placed on evidence in the workspace.",
  },
  {
    eventType: "governance.export_blocked",
    description: "An export was blocked by governance policy.",
  },
];

export default function OrganizationAdminIntegrationsPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <IntegrationsTab />
    </PageRouteGate>
  );
}

function IntegrationsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [state, setState] = useState<Loadable<WorkspacesResponse>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/orgs/${orgId}/workspaces`,
      )) as WorkspacesResponse;
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
          message: "Failed to load workspaces.",
        }).message;
        setState({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const workspaceColumns: DataTableColumn<OrgWorkspace>[] = [
    {
      key: "name",
      header: "Workspace",
      render: (w) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{w.name}</div>
          <div style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
            API keys + webhook endpoints
          </div>
        </div>
      ),
    },
  ];

  return (
    <section
      data-testid="org-admin-integrations"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      {/* Intro */}
      <Card
        variant="summary"
        data-section="integrations-intro"
        title="API & integrations"
        subtitle="API keys and webhook endpoints are managed per workspace. Open a workspace below to view or manage its API keys (create, revoke, rotate) and webhook endpoints (delivery history, failures, secret rotation) on the canonical integrations surface."
      />

      {/* Per-workspace deep-link index */}
      <Card
        variant="admin"
        data-section="integrations-workspaces"
        title="Workspaces"
      >
        {state.kind === "loading" ? (
          <div data-state="loading" style={mutedText}>
            Loading…
          </div>
        ) : state.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
            {state.status === 403
              ? "You don't have access to this organization's workspaces."
              : state.message}
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
          </div>
        ) : state.data.workspaces.length === 0 ? (
          <div data-testid="integrations-workspaces-empty">
            <EmptyState
              compact
              framed
              title="No workspaces on this plan"
              purpose="Workspaces bound to this organization appear here, each with a deep-link into its integrations portal."
            />
          </div>
        ) : (
          <div data-testid="integrations-workspaces-list">
            <DataTable
              ariaLabel="Organization workspaces"
              columns={workspaceColumns}
              rows={state.data.workspaces}
              getRowId={(w) => w.id}
              rowActions={(w) => (
                // Deep-link into the canonical workspace-scoped
                // integrations portal. The integrations page reads the
                // active workspace from platform-context; the ?team hint
                // lets it land pre-scoped where supported.
                <Link
                  href={`/integrations?team=${encodeURIComponent(w.id)}`}
                  data-testid={`integrations-open-${w.id}`}
                  data-workspace-id={w.id}
                  style={{ textDecoration: "none" }}
                >
                  <Button variant="secondary" size="sm">
                    Manage →
                  </Button>
                </Link>
              )}
            />
          </div>
        )}
      </Card>

      {/* Canonical portal deep-link */}
      <Card
        variant="summary"
        data-section="integrations-deep-link"
        style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <div style={{ fontWeight: 600 }}>Integrations portal</div>
          <div style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
            Full developer portal for the active workspace — API keys,
            webhook endpoints, delivery health, and signature docs.
          </div>
        </div>
        <Link
          href="/integrations"
          data-testid="integrations-deep-link-portal"
          style={{ textDecoration: "none", flexShrink: 0 }}
        >
          <Button variant="secondary" size="sm">
            Open portal →
          </Button>
        </Link>
      </Card>

      {/* Evidence-relevant webhook events (read-only reference) */}
      <Card
        variant="admin"
        data-section="integrations-events"
        title="Evidence webhook events"
        subtitle="Event types the API produces today. Subscribe to these when creating a webhook endpoint on a workspace."
      >
        <ul
          data-testid="integrations-event-list"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {EVIDENCE_WEBHOOK_EVENTS.map((ev) => (
            <li
              key={ev.eventType}
              data-event-type={ev.eventType}
              style={{
                padding: "8px 0",
                borderBottom:
                  "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                fontSize: 13,
              }}
            >
              <code style={{ fontSize: 12 }}>{ev.eventType}</code>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ink-secondary, #475569)",
                  marginTop: 2,
                }}
              >
                {ev.description}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

const mutedText: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};
