"use client";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

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
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
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
        const message = toSafeUserError(err, { message: "Failed to load." }).message;
        setPolicy({ kind: "error", message, status: 0 });
      }
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      data-testid="org-admin-retention"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="admin"
        data-section="retention-policy"
        title="Retention template"
        subtitle="The published organization-level retention template. Workspaces inherit it unless overridden."
      >
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
          <EmptyState
            data-state="not-configured"
            data-testid="retention-not-configured"
            framed
            compact
            title="No retention policy configured"
            purpose="No organization-level retention template is published. Workspaces fall back to their workspace-scoped retention policy. Publish a template from Evidence Lifecycle → Retention to set the default."
            action={
              <Link
                href="/evidence-lifecycle/retention"
                style={{ textDecoration: "none" }}
              >
                <Button variant="secondary" size="sm">
                  Open Evidence Lifecycle → Retention
                </Button>
              </Link>
            }
          />
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
      </Card>

      <PageSection
        title="Canonical retention & legal hold surfaces"
        description="Retention runs, legal holds, and destruction reviews are mutated on the Evidence Lifecycle pages. Open them below."
      >
        <div
          data-section="retention-deep-links"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
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
        </div>
      </PageSection>
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
    <Card
      variant="summary"
      padding="compact"
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-secondary, #475569)",
            marginTop: 2,
          }}
        >
          {description}
        </div>
      </div>
      <Link href={href} data-testid={testId} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Button variant="secondary" size="sm">
          Open →
        </Button>
      </Link>
    </Card>
  );
}
