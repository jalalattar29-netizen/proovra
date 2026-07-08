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
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

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

  return (
    <section data-testid="org-admin-integrations" data-org-id={orgId}>
      {/* Intro */}
      <section data-section="integrations-intro" style={cardStyle}>
        <h2 style={{ margin: 0, fontSize: 16 }}>API &amp; integrations</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          API keys and webhook endpoints are managed per workspace. Open a
          workspace below to view or manage its API keys (create, revoke,
          rotate) and webhook endpoints (delivery history, failures, secret
          rotation) on the canonical integrations surface.
        </p>
      </section>

      {/* Per-workspace deep-link index */}
      <section data-section="integrations-workspaces" style={cardStyle}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Workspaces</h3>
        {state.kind === "loading" ? (
          <div data-state="loading" style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>
            Loading…
          </div>
        ) : state.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13, marginTop: 8 }}>
            {state.status === 403
              ? "You don't have access to this organization's workspaces."
              : state.message}
            {state.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontFamily: "monospace",
                  opacity: 0.7,
                }}
              >
                Request id: {state.requestId}
              </div>
            ) : null}
          </div>
        ) : state.data.workspaces.length === 0 ? (
          <div
            data-testid="integrations-workspaces-empty"
            style={{ fontSize: 13, opacity: 0.75, marginTop: 8 }}
          >
            No workspaces are bound to this organization yet.
          </div>
        ) : (
          <ul
            data-testid="integrations-workspaces-list"
            style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}
          >
            {state.data.workspaces.map((w) => (
              <li
                key={w.id}
                data-workspace-id={w.id}
                style={rowStyle}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div style={{ fontWeight: 500 }}>{w.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    API keys + webhook endpoints
                  </div>
                </div>
                {/* Deep-link into the canonical workspace-scoped
                    integrations portal. The integrations page reads the
                    active workspace from platform-context; the ?team hint
                    lets it land pre-scoped where supported. */}
                <Link
                  href={`/integrations?team=${encodeURIComponent(w.id)}`}
                  data-testid={`integrations-open-${w.id}`}
                  className="cases-filter-chip"
                >
                  Manage →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Canonical portal deep-link */}
      <section data-section="integrations-deep-link" style={cardStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <div style={{ fontWeight: 600 }}>Integrations portal</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Full developer portal for the active workspace — API keys,
              webhook endpoints, delivery health, and signature docs.
            </div>
          </div>
          <Link
            href="/integrations"
            data-testid="integrations-deep-link-portal"
            className="cases-filter-chip"
          >
            Open portal →
          </Link>
        </div>
      </section>

      {/* Evidence-relevant webhook events (read-only reference) */}
      <section data-section="integrations-events" style={cardStyle}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Evidence webhook events</h3>
        <p style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
          Event types the API produces today. Subscribe to these when
          creating a webhook endpoint on a workspace.
        </p>
        <ul
          data-testid="integrations-event-list"
          style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}
        >
          {EVIDENCE_WEBHOOK_EVENTS.map((ev) => (
            <li
              key={ev.eventType}
              data-event-type={ev.eventType}
              style={{
                padding: "0.4rem 0",
                borderBottom: "1px solid rgba(127,127,127,0.18)",
                fontSize: 13,
              }}
            >
              <code style={{ fontSize: 12 }}>{ev.eventType}</code>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                {ev.description}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles — mirror the sibling admin tabs.
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
  marginBottom: "1rem",
};

const rowStyle: React.CSSProperties = {
  padding: "0.5rem 0",
  borderBottom: "1px solid rgba(127,127,127,0.18)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};
