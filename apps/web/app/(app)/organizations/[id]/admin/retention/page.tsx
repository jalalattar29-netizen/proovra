"use client";

/**
 * Phase 8 — Org admin / Retention & Legal hold tab.
 *
 * Reads the Phase B0 org-scoped retention policy endpoint
 * (/v1/orgs/:id/policies/retention) plus surfaces canonical deep-links
 * for retention runs and legal-hold workflows. Mutations happen on
 * Evidence Lifecycle pages, not here — this tab is read-only posture.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only surface).
 *   - No platform-context workspace-fragment reads — apiFetch only.
 *   - Strong TypeScript types throughout.
 *   - Surface honestly states "not configured" when no template exists.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../../../lib/api";
import { formatUserDateTime } from "../../../../../../lib/date";

interface RetentionResponse {
  organizationId: string;
  key: string;
  value: Record<string, unknown> | null;
  updatedAt: string | null;
  lastUpdatedByUserId: string | null;
  inheritance: {
    workspaceCount: number;
    sample: Array<{ id: string; name: string }>;
  };
}

type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string; status: number; requestId?: string };

export default function OrganizationAdminRetentionPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <RetentionTab />
    </PageRouteGate>
  );
}

function RetentionTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  const [policy, setPolicy] = useState<Loadable<RetentionResponse>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    if (!orgId) return;
    setPolicy({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/orgs/${orgId}/policies/retention`,
      )) as RetentionResponse;
      setPolicy({ kind: "ready", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setPolicy({
          kind: "error",
          message: err.message,
          status: err.statusCode ?? 0,
          requestId: err.requestId,
        });
      } else {
        const message = err instanceof Error ? err.message : "Failed to load.";
        setPolicy({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="org-admin-retention" data-org-id={orgId}>
      <section
        data-section="retention-policy"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Retention template</h2>
        <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
          The published organization-level retention template. Workspaces
          inherit it unless overridden.
        </p>
        {policy.kind === "loading" ? (
          <div data-state="loading" style={{ fontSize: 13, opacity: 0.7 }}>
            Loading…
          </div>
        ) : policy.kind === "error" ? (
          <div data-state="error" role="alert" style={{ fontSize: 13 }}>
            {policy.status === 403
              ? "You don't have access to org-level retention configuration."
              : policy.message}
            {policy.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  fontFamily: "monospace",
                  opacity: 0.7,
                }}
              >
                Request id: {policy.requestId}
              </div>
            ) : null}
          </div>
        ) : policy.data.value === null ? (
          <div
            data-state="not-configured"
            data-testid="retention-not-configured"
            style={{
              padding: "0.6rem 0.7rem",
              border: "1px dashed rgba(127,127,127,0.45)",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <strong>Not configured.</strong> No organization-level retention
            template is published. Workspaces fall back to their workspace-
            scoped retention policy. Publish a template from
            Evidence Lifecycle → Retention to set the default.
          </div>
        ) : (
          <div data-state="configured" style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 6 }}>
              <strong>Published.</strong>
              {policy.data.updatedAt
                ? ` Last updated ${formatUserDateTime(policy.data.updatedAt)}.`
                : null}
            </div>
            <pre
              data-testid="retention-template-json"
              style={{
                maxHeight: 260,
                overflow: "auto",
                background: "rgba(127,127,127,0.08)",
                padding: "0.5rem 0.6rem",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {JSON.stringify(policy.data.value, null, 2)}
            </pre>
          </div>
        )}
        {policy.kind === "ready" ? (
          <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
            Inherits to {policy.data.inheritance.workspaceCount} workspace
            {policy.data.inheritance.workspaceCount === 1 ? "" : "s"} bound
            to this organization.
          </p>
        ) : null}
      </section>

      <section
        data-section="retention-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>
          Canonical retention &amp; legal hold surfaces
        </h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="ret-deep-link-retention"
            label="Evidence Lifecycle · Retention"
            description="Retention runs, scheduled jobs, and workspace overrides."
            href="/evidence-lifecycle/retention"
          />
          <DeepLink
            testId="ret-deep-link-legal-holds"
            label="Evidence Lifecycle · Legal holds"
            description="Place, list, and release legal holds (mutation requires ADMIN+)."
            href="/evidence-lifecycle/legal-holds"
          />
          <DeepLink
            testId="ret-deep-link-destruction"
            label="Evidence Lifecycle · Destruction"
            description="Two-person destruction reviews + executions."
            href="/evidence-lifecycle/destruction"
          />
        </ul>
      </section>
    </section>
  );
}

function DeepLink({
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
        padding: "0.5rem 0",
        borderBottom: "1px solid rgba(127,127,127,0.18)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{description}</div>
      </div>
      <Link
        href={href}
        data-testid={testId}
        className="cases-filter-chip"
      >
        Open →
      </Link>
    </li>
  );
}
