"use client";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

/**
 * Phase 8 — Org admin / Retention & Legal hold tab.
 *
 * Reads the Phase B0 org-scoped retention policy endpoint
 * (/v1/orgs/:id/policies/retention) plus surfaces canonical deep-links
 * for retention runs and legal-hold workflows.
 *
 * PRO-CENZ-01 / EP-0806 — the organization template is PUBLISHED here
 * (POST /v1/orgs/:id/policies/retention). The page used to tell admins to
 * "publish a template from Evidence Lifecycle → Retention", which only writes
 * a workspace policy; no control reached the organization route. The form is
 * offered only when the read says `viewer.canPublish` (the POST's own gate:
 * organization owner or admin of a customer organization). Workspace
 * retention runs, legal holds and destruction stay on Evidence Lifecycle.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm.
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
import { apiFetch, isApiResponseError } from "../../../../../../lib/api";
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
  /** Policies in force in the workspaces, in either policy table. */
  workspacePolicies?: {
    activePolicyCount: number;
    workspacesWithPolicyCount: number;
  };
  /**
   * PRO-CENZ-01 / EP-0806 — whether this caller may publish, decided by the
   * POST's own gate (organization owner or admin). Absent: not offered.
   */
  viewer?: { canPublish: boolean };
}

/** The template as the API stores it (organizations-governance.routes.ts). */
type RetentionTemplateValue = {
  retentionDays: number | null;
  immutable: boolean;
  description: string | null;
};

function readTemplate(value: Record<string, unknown> | null): RetentionTemplateValue | null {
  if (!value) return null;
  const days = value["retentionDays"];
  const description = value["description"];
  return {
    retentionDays: typeof days === "number" ? days : null,
    immutable: value["immutable"] === true,
    description: typeof description === "string" ? description : null,
  };
}

const MAX_RETENTION_DAYS = 365 * 50;

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

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!orgId) return;
    // After a publish the card re-reads without unmounting the form, so its
    // confirmation stays on screen.
    if (!opts?.quiet) setPolicy({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/orgs/${orgId}/policies/retention`,
      )) as RetentionResponse;
      setPolicy({ kind: "ready", data });
    } catch (err) {
      if (isApiResponseError(err)) {
        setPolicy({
          kind: "error",
          message: toSafeUserError(err, { message: "Failed to load." }).message,
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
            title="No organization-wide default"
            purpose={
              policy.data.viewer?.canPublish
                ? "No organization-level retention template is published. Workspaces follow their own retention policies. Publish one below to set the default for every workspace without a policy of its own."
                : "No organization-level retention template is published. Workspaces follow their own retention policies. An organization owner or admin can publish the default here."
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
        {policy.kind === "ready" && policy.data.workspacePolicies ? (
          <p data-testid="retention-workspace-policies" style={{ fontSize: 13, marginTop: 8 }}>
            {policy.data.workspacePolicies.activePolicyCount} polic
            {policy.data.workspacePolicies.activePolicyCount === 1 ? "y" : "ies"} in force across{" "}
            {policy.data.workspacePolicies.workspacesWithPolicyCount} of{" "}
            {policy.data.inheritance.workspaceCount} workspace
            {policy.data.inheritance.workspaceCount === 1 ? "" : "s"}.
          </p>
        ) : null}
        {policy.kind === "ready" ? (
          <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
            Inherits to {policy.data.inheritance.workspaceCount} workspace
            {policy.data.inheritance.workspaceCount === 1 ? "" : "s"} bound
            to this organization.
          </p>
        ) : null}
        {policy.kind === "ready" ? (
          policy.data.viewer?.canPublish ? (
            <PublishRetentionTemplateForm
              orgId={orgId}
              current={readTemplate(policy.data.value)}
              onPublished={() => void load({ quiet: true })}
            />
          ) : (
            <p
              data-testid="retention-publish-not-offered"
              style={{ fontSize: 12.5, marginTop: 12, color: "var(--ink-secondary, #475569)" }}
            >
              Only an organization owner or admin can publish or change this
              template. Your role can read it.
            </p>
          )
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
            description="Place, list and release legal holds. Changes require the Admin role or higher."
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

/**
 * EP-0806 — publish (or replace) the organization retention template. The
 * body is the route's bounded shape: whole days 0..18250 or indefinite, the
 * "workspaces may not shorten it" flag, and an optional description (≤400).
 */
function PublishRetentionTemplateForm({
  orgId,
  current,
  onPublished,
}: {
  orgId: string;
  current: RetentionTemplateValue | null;
  onPublished: () => void;
}) {
  const [indefinite, setIndefinite] = useState(current !== null && current.retentionDays === null);
  const [days, setDays] = useState(
    current?.retentionDays !== null && current?.retentionDays !== undefined ? String(current.retentionDays) : "",
  );
  const [immutable, setImmutable] = useState(current?.immutable ?? false);
  const [description, setDescription] = useState(current?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parsedDays = Number(days);
  const daysValid =
    indefinite || (days.trim() !== "" && Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= MAX_RETENTION_DAYS);

  const publish = async () => {
    if (!daysValid || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/v1/orgs/${orgId}/policies/retention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retentionDays: indefinite ? null : parsedDays,
          immutable,
          description: description.trim() === "" ? null : description.trim(),
        }),
      });
      setNotice("Template published. Workspaces without a retention policy of their own now inherit it.");
      onPublished();
    } catch (err) {
      const code = (err as { code?: string }).code;
      const status = (err as { statusCode?: number }).statusCode;
      if (code === "forbidden" || status === 403) {
        setError(
          code === "session_quarantined"
            ? "This session is restricted after a security check. Sign in again, then publish."
            : "Only an organization owner or admin can publish the retention template.",
        );
      } else if (code === "not_found" || status === 404) {
        setError("This organization is not available to you any more.");
      } else {
        setError(toSafeUserError(err, { message: "The template could not be published." }).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    fontSize: 13,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--border-default, rgba(15,23,42,0.15))",
  };

  return (
    <form
      data-testid="retention-publish-form"
      onSubmit={(e) => {
        e.preventDefault();
        void publish();
      }}
      style={{ display: "grid", gap: 10, marginTop: 16, fontSize: 13 }}
    >
      <strong>{current ? "Change the template" : "Publish a template"}</strong>
      <label style={{ display: "grid", gap: 4 }}>
        Keep evidence for (days)
        <input
          type="number"
          min={0}
          max={MAX_RETENTION_DAYS}
          step={1}
          value={days}
          disabled={indefinite || busy}
          onChange={(e) => setDays(e.target.value)}
          aria-invalid={!daysValid || undefined}
          style={{ ...inputStyle, maxWidth: 160 }}
        />
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={indefinite}
          disabled={busy}
          onChange={(e) => setIndefinite(e.target.checked)}
        />
        Indefinitely, until an explicit destruction decision
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={immutable}
          disabled={busy}
          onChange={(e) => setImmutable(e.target.checked)}
        />
        Make it a floor: a workspace policy may lengthen this period but never shorten it
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        Description (optional)
        <textarea
          value={description}
          maxLength={400}
          rows={2}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
          style={inputStyle}
        />
      </label>
      {!daysValid ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
          Enter a whole number of days from 0 to {MAX_RETENTION_DAYS}, or choose indefinitely.
        </p>
      ) : null}
      <p style={{ margin: 0, fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
        A workspace with its own retention policy keeps it, except that a floor
        replaces a shorter workspace period. Legal holds and the destruction
        review still apply to every record.
      </p>
      <div>
        <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={busy || !daysValid}>
          {current ? "Publish changes" : "Publish template"}
        </Button>
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 12.5, color: "#8f1d16" }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" style={{ fontSize: 12.5, color: "#215e44" }}>
          {notice}
        </div>
      ) : null}
    </form>
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
